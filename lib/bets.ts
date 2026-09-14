// My Bets page — wallet bet discovery, classification, and payout replication.
//
// Contract calls here were verified live against SportsbookMarket-v1_9.sol and
// the deployed Chiefs/Eagles test market (0x4C67...c441C) before this file was
// written, and confirmed again against production traffic when the first
// version of this file broke it:
//   - getBetsByAddress(bettor) returns a wallet's bet ids on one market in a
//     SINGLE eth_call — no block-range scanning of any kind. This file used
//     to discover bets via chunked eth_getLogs (filtered on the indexed
//     `bettor` topic) instead; that shipped to production and produced a
//     1000+-request storm within seconds. The proximate trigger was Alchemy's
//     free-tier eth_getLogs cap — 10 blocks per call (not the 2,000-block cap
//     the public Base RPC fallback has, which the chunking size was tuned
//     for) — so bisecting a multi-day window down to that cap fanned out
//     recursively. But the real bug was reaching for eth_getLogs at all when
//     the contract already exposes a direct per-address getter that needs no
//     block range whatsoever. Never reintroduce eth_getLogs here.
//   - getBet(betId) returns the live Bet{bettor,stake,greaterThan,lockedZ,claimed}
//     struct — field names/types match what's used below.
//   - getMarketState()/getMarketStatus() tuples match what's decoded below.

import type { Address, PublicClient } from 'viem'
import { marketAbi } from '@/lib/contracts'
import type { ParsedMarket } from '@/lib/markets'

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// Circuit breaker for every RPC call in this file: bounded attempts with
// exponential backoff, then throw — never retry forever, and never swallow a
// real failure into a silent "no bets" result (the caller needs to be able to
// tell "this market failed to load" apart from "this wallet has no bets on
// it," or a transient RPC hiccup on production shows up as bets quietly
// disappearing instead of a visible error).
const MAX_ATTEMPTS = 3
const BASE_BACKOFF_MS = 500

async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  let lastErr: unknown
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (attempt < MAX_ATTEMPTS - 1) {
        await sleep(BASE_BACKOFF_MS * 2 ** attempt) // 500ms, 1000ms
      }
    }
  }
  console.error(`[bets] ${label} failed after ${MAX_ATTEMPTS} attempts:`, lastErr)
  throw lastErr
}

// ── Market snapshot + payout replication ───────────────────────────────────

export interface MarketSnapshot {
  gameId: string
  currentZ: bigint
  totalPool: bigint
  bettingOpen: boolean
  settled: boolean
  canceled: boolean
  refundMode: boolean
  finalSpread: bigint
  cachedWinningStakes: bigint
  protocolSeedTotal: bigint
}

export async function fetchMarketSnapshot(
  client: PublicClient,
  marketAddress: Address,
): Promise<MarketSnapshot> {
  const results = await withRetry(
    () =>
      client.multicall({
        contracts: [
          { address: marketAddress, abi: marketAbi, functionName: 'getMarketState' },
          { address: marketAddress, abi: marketAbi, functionName: 'getMarketStatus' },
          { address: marketAddress, abi: marketAbi, functionName: 'refundMode' },
          { address: marketAddress, abi: marketAbi, functionName: 'finalSpread' },
          { address: marketAddress, abi: marketAbi, functionName: 'cachedWinningStakes' },
          { address: marketAddress, abi: marketAbi, functionName: 'protocolSeedTotal' },
        ],
        allowFailure: true,
      }),
    `fetchMarketSnapshot(${marketAddress})`
  )

  const [stateR, statusR, refundR, spreadR, winStakesR, seedR] = results
  if (stateR.status !== 'success' || statusR.status !== 'success') {
    throw new Error(`fetchMarketSnapshot(${marketAddress}): core reads failed`)
  }

  const [gameId, currentZ, , , totalPool, bettingOpen, settled] = stateR.result as readonly [
    string, bigint, bigint, bigint, bigint, boolean, boolean,
  ]
  const [isCanceled] = statusR.result as readonly [boolean, boolean, boolean, bigint, bigint]

  return {
    gameId,
    currentZ,
    totalPool,
    bettingOpen,
    settled,
    canceled: isCanceled,
    refundMode: refundR.status === 'success' ? (refundR.result as boolean) : false,
    finalSpread: spreadR.status === 'success' ? (spreadR.result as bigint) : BigInt(0),
    cachedWinningStakes: winStakesR.status === 'success' ? (winStakesR.result as bigint) : BigInt(0),
    protocolSeedTotal: seedR.status === 'success' ? (seedR.result as bigint) : BigInt(0),
  }
}

export interface RawBet {
  betId: bigint
  stake: bigint
  greaterThan: boolean
  lockedZ: bigint
  claimed: boolean
}

/**
 * A wallet's bets on one market — via getBetsByAddress(bettor) for the id
 * list, then one multicall of getBet(id) for the full Bet struct (stake,
 * side, lockedZ, claimed) per id. Two RPC round-trips total, regardless of
 * how far back the market opened or how long ago it settled.
 */
export async function fetchWalletBets(
  client: PublicClient,
  marketAddress: Address,
  bettor: Address,
): Promise<RawBet[]> {
  const betIds = await withRetry(
    () =>
      client.readContract({
        address: marketAddress,
        abi: marketAbi,
        functionName: 'getBetsByAddress',
        args: [bettor],
      }),
    `getBetsByAddress(${marketAddress})`
  )
  if (betIds.length === 0) return []

  const results = await withRetry(
    () =>
      client.multicall({
        contracts: betIds.map(betId => ({
          address: marketAddress,
          abi: marketAbi,
          functionName: 'getBet' as const,
          args: [betId] as const,
        })),
        allowFailure: true,
      }),
    `getBet×${betIds.length}(${marketAddress})`
  )

  const bets: RawBet[] = []
  results.forEach((r, i) => {
    if (r.status !== 'success') return
    const bet = r.result as { stake: bigint; greaterThan: boolean; lockedZ: bigint; claimed: boolean }
    bets.push({
      betId: betIds[i],
      stake: bet.stake,
      greaterThan: bet.greaterThan,
      lockedZ: bet.lockedZ,
      claimed: bet.claimed,
    })
  })
  return bets
}

export type BetStatus = 'active' | 'awaiting' | 'claimable' | 'won' | 'lost' | 'refunded'
/** The bet's resolved outcome once the market is finalized — independent of whether it's been claimed yet. */
export type BetOutcome = 'won' | 'lost' | 'refunded'

export interface WalletBet {
  market: ParsedMarket
  betId: bigint
  side: 'home' | 'away'
  stake: bigint
  lockedZ: bigint
  /** Market's current Z at scan time — for Active bets, shown alongside lockedZ so the line-move is visible. */
  currentZ: bigint
  status: BetStatus
  outcome: BetOutcome | null
  /** Payout in USDC base units — the exact figure claimPayout would transfer. */
  payout: bigint
  claimed: boolean
}

/**
 * Replicates SportsbookMarket._calculatePayout() exactly (SportsbookMarket-v1_9.sol
 * ~line 538): refundMode returns the full stake back; otherwise a losing bet is
 * zero and a winning bet is its proportional share of (totalPool - protocolSeedTotal).
 * No PROTOCOL_SEED-in-denominator quoting bug here (see lib/payout.ts) — that bug
 * only affects the pre-bet getMarketEV/simulatePayout quotes; cachedWinningStakes
 * never counts the seed, so this is the real, exact settlement payout.
 */
function calculatePayout(
  stake: bigint,
  greaterThan: boolean,
  lockedZ: bigint,
  snapshot: MarketSnapshot,
): { isWinner: boolean; payout: bigint } {
  if (snapshot.refundMode) return { isWinner: true, payout: stake }

  const scaledSpread = snapshot.finalSpread * BigInt(10_000)
  const isWinner = greaterThan ? scaledSpread > lockedZ : scaledSpread <= lockedZ
  if (!isWinner) return { isWinner: false, payout: BigInt(0) }
  if (snapshot.cachedWinningStakes === BigInt(0)) return { isWinner: true, payout: BigInt(0) }

  const distributable = snapshot.totalPool - snapshot.protocolSeedTotal
  const payout = (stake * distributable) / snapshot.cachedWinningStakes
  return { isWinner: true, payout }
}

export function classifyBets(
  market: ParsedMarket,
  snapshot: MarketSnapshot,
  rawBets: RawBet[],
): WalletBet[] {
  const finalized = snapshot.settled || snapshot.canceled

  return rawBets.map(raw => {
    const side: 'home' | 'away' = raw.greaterThan ? 'home' : 'away'

    if (!finalized) {
      return {
        market,
        betId: raw.betId,
        side,
        stake: raw.stake,
        lockedZ: raw.lockedZ,
        currentZ: snapshot.currentZ,
        status: snapshot.bettingOpen ? 'active' : 'awaiting',
        outcome: null,
        payout: BigInt(0),
        claimed: false,
      }
    }

    const { payout } = calculatePayout(raw.stake, raw.greaterThan, raw.lockedZ, snapshot)
    const outcome: BetOutcome = snapshot.refundMode ? 'refunded' : payout > BigInt(0) ? 'won' : 'lost'

    return {
      market,
      betId: raw.betId,
      side,
      stake: raw.stake,
      lockedZ: raw.lockedZ,
      currentZ: snapshot.currentZ,
      // Unclaimed + a nonzero payout (won or refund) is what actually shows in
      // the Claimable section; claimed or zero-payout (lost) bets go straight
      // to History — a losing bet's `claimed` flag never flips true on-chain
      // (claimPayout reverts before that write is committed), so it can only
      // ever land in History, never Claimable.
      status: !raw.claimed && payout > BigInt(0) ? 'claimable' : outcome,
      outcome,
      payout,
      claimed: raw.claimed,
    }
  })
}
