// My Bets page — wallet bet discovery, classification, and payout replication.
//
// Contract calls here were verified live against SportsbookMarket-v1_9.sol and
// the deployed Chiefs/Eagles test market (0x4C67...c441C) before this file was
// written:
//   - BetPlaced's `bettor` param IS indexed, so logs can be filtered on-chain
//     by wallet address instead of fetched in full and filtered client-side.
//   - getBet(betId) returns the live Bet{bettor,stake,greaterThan,lockedZ,claimed}
//     struct — field names/types match what's used below.
//   - getMarketState()/getMarketStatus() tuples match what's decoded below.
//   - eth_getLogs on the public Base RPC (used as a dev fallback — production
//     uses Alchemy per lib/wagmi.ts) is capped at a 2,000-block range, which is
//     why fetchBetLogs chunks/bisects instead of requesting one wide range.

import type { Address, PublicClient } from 'viem'
import { parseAbiItem } from 'viem'
import { marketAbi } from '@/lib/contracts'
import type { ParsedMarket } from '@/lib/markets'
import { parseMarketDate } from '@/lib/format'

const BET_PLACED_EVENT = parseAbiItem(
  'event BetPlaced(address indexed bettor, uint256 indexed betId, uint256 stake, uint256 fee, bool greaterThan, int256 lockedZ)'
)

// Base block time is ~2s. BetPlaced can only fire while bettingOpen is true —
// i.e. between openMarket() and closeBetting(), which per CLAUDE.md happens
// at/around kickoff — so the log-scan window is bounded by the market's own
// lifecycle, not by how long payouts stay claimable afterward (that's the
// 90-day CLAIM_TIMEOUT, a completely different window that has nothing to do
// with when a bet could have been *placed*). Getting this wrong by using the
// claim window here (an earlier version of this file did) turns a scan that
// should span hours-to-days into one spanning months — thousands of chunked
// requests against a range-limited RPC instead of a handful.
const BLOCK_TIME_SEC = 2
// bettingOpensAt is the tight lower bound; this is only a fallback for a row
// missing that column.
const FALLBACK_LOOKBACK_BEFORE_GAME_DAYS = 7
const LOOKAHEAD_AFTER_GAME_DAYS = 2 // closeBetting() happens at/near kickoff; small slack for late closes
const FALLBACK_LOOKBACK_DAYS = 14 // used when neither bettingOpensAt nor gameDate parse
const PUBLIC_RPC_CHUNK = BigInt(1_800) // stays under the public fallback's 2,000-block cap

function approxBlockForTimestamp(
  targetSec: number,
  currentBlock: bigint,
  currentSec: number,
): bigint {
  const deltaSec = currentSec - targetSec
  const deltaBlocks = BigInt(Math.max(0, Math.round(deltaSec / BLOCK_TIME_SEC)))
  return deltaBlocks > currentBlock ? BigInt(0) : currentBlock - deltaBlocks
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// Distinguishes "this range is too wide for the RPC" (worth bisecting) from
// rate-limiting/transient failures (worth backing off on, NOT bisecting —
// splitting a 429 into two parallel sub-requests turns one rate-limit hit
// into a request storm, which is what happens if every error is treated the
// same way).
function isRangeLimitError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /range|-32614|block count|exceeds the range/i.test(msg)
}

const RATE_LIMIT_RETRIES = 4
const RATE_LIMIT_BACKOFF_MS = 600

async function scanRange(
  client: PublicClient,
  address: Address,
  bettor: Address,
  fromBlock: bigint,
  toBlock: bigint,
  rateLimitAttempt = 0,
): Promise<readonly { args: { betId?: bigint; stake?: bigint; greaterThan?: boolean; lockedZ?: bigint } }[]> {
  try {
    return await client.getLogs({
      address,
      event: BET_PLACED_EVENT,
      args: { bettor },
      fromBlock,
      toBlock,
    })
  } catch (err) {
    if (!isRangeLimitError(err)) {
      // Rate limit / transient network error: back off and retry the SAME
      // range rather than splitting it into more concurrent requests.
      if (rateLimitAttempt < RATE_LIMIT_RETRIES) {
        await sleep(RATE_LIMIT_BACKOFF_MS * (rateLimitAttempt + 1))
        return scanRange(client, address, bettor, fromBlock, toBlock, rateLimitAttempt + 1)
      }
      console.error(`[bets] giving up on block range ${fromBlock}-${toBlock} after repeated failures:`, err)
      return []
    }

    if (toBlock <= fromBlock) return []
    if (toBlock - fromBlock <= PUBLIC_RPC_CHUNK) {
      // Already at (or under) the conservative chunk size and still hitting a
      // range-limit error — nothing smaller to try, so give up on this slice.
      return []
    }
    const mid = fromBlock + (toBlock - fromBlock) / BigInt(2)
    // Sequential, not Promise.all: splitting a too-wide range is expected to
    // happen rarely (only against the public-RPC dev fallback — Alchemy in
    // production handles much wider ranges in one call), and firing every
    // bisected half at once is exactly the fan-out that turns one slow
    // endpoint into a self-inflicted rate-limit storm.
    const left = await scanRange(client, address, bettor, fromBlock, mid)
    const right = await scanRange(client, address, bettor, mid + BigInt(1), toBlock)
    return [...left, ...right]
  }
}

export interface RawBetLog {
  betId: bigint
  stake: bigint
  greaterThan: boolean
  lockedZ: bigint
}

/** BetPlaced logs for one wallet on one market, filtered on-chain by indexed `bettor`. */
export async function fetchBetLogs(
  client: PublicClient,
  marketAddress: Address,
  bettor: Address,
  gameDateIso: string | undefined,
  bettingOpensAtIso: string | undefined,
  currentBlock: bigint,
  currentSec: number,
): Promise<RawBetLog[]> {
  const gameSec = (parseMarketDate(gameDateIso)?.getTime() ?? NaN) / 1000
  const opensSec = (parseMarketDate(bettingOpensAtIso)?.getTime() ?? NaN) / 1000

  let fromTargetSec: number
  if (Number.isFinite(opensSec)) fromTargetSec = opensSec
  else if (Number.isFinite(gameSec)) fromTargetSec = gameSec - FALLBACK_LOOKBACK_BEFORE_GAME_DAYS * 86400
  else fromTargetSec = currentSec - FALLBACK_LOOKBACK_DAYS * 86400

  const toTargetSec = Number.isFinite(gameSec) ? Math.min(currentSec, gameSec + LOOKAHEAD_AFTER_GAME_DAYS * 86400) : currentSec

  const fromBlock = approxBlockForTimestamp(fromTargetSec, currentBlock, currentSec)
  const toBlock =
    toTargetSec >= currentSec ? currentBlock : approxBlockForTimestamp(toTargetSec, currentBlock, currentSec)

  const logs = await scanRange(client, marketAddress, bettor, fromBlock, toBlock)
  return logs
    .filter(l => l.args.betId !== undefined)
    .map(l => ({
      betId: l.args.betId as bigint,
      stake: l.args.stake as bigint,
      greaterThan: l.args.greaterThan as boolean,
      lockedZ: l.args.lockedZ as bigint,
    }))
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
): Promise<MarketSnapshot | null> {
  const results = await client.multicall({
    contracts: [
      { address: marketAddress, abi: marketAbi, functionName: 'getMarketState' },
      { address: marketAddress, abi: marketAbi, functionName: 'getMarketStatus' },
      { address: marketAddress, abi: marketAbi, functionName: 'refundMode' },
      { address: marketAddress, abi: marketAbi, functionName: 'finalSpread' },
      { address: marketAddress, abi: marketAbi, functionName: 'cachedWinningStakes' },
      { address: marketAddress, abi: marketAbi, functionName: 'protocolSeedTotal' },
    ],
    allowFailure: true,
  })

  const [stateR, statusR, refundR, spreadR, winStakesR, seedR] = results
  if (stateR.status !== 'success' || statusR.status !== 'success') return null

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

/** Live `claimed` flags for a set of bet ids on one market, via getBet(betId). */
export async function fetchClaimedFlags(
  client: PublicClient,
  marketAddress: Address,
  betIds: bigint[],
): Promise<Map<bigint, boolean>> {
  if (betIds.length === 0) return new Map()
  const results = await client.multicall({
    contracts: betIds.map(betId => ({
      address: marketAddress,
      abi: marketAbi,
      functionName: 'getBet' as const,
      args: [betId] as const,
    })),
    allowFailure: true,
  })
  const map = new Map<bigint, boolean>()
  results.forEach((r, i) => {
    if (r.status === 'success') {
      const bet = r.result as { claimed: boolean }
      map.set(betIds[i], bet.claimed)
    }
  })
  return map
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
  logs: RawBetLog[],
  claimedFlags: Map<bigint, boolean>,
): WalletBet[] {
  const finalized = snapshot.settled || snapshot.canceled

  return logs.map(log => {
    const side: 'home' | 'away' = log.greaterThan ? 'home' : 'away'
    const claimed = claimedFlags.get(log.betId) ?? false

    if (!finalized) {
      return {
        market,
        betId: log.betId,
        side,
        stake: log.stake,
        lockedZ: log.lockedZ,
        currentZ: snapshot.currentZ,
        status: snapshot.bettingOpen ? 'active' : 'awaiting',
        outcome: null,
        payout: BigInt(0),
        claimed: false,
      }
    }

    const { payout } = calculatePayout(log.stake, log.greaterThan, log.lockedZ, snapshot)
    const outcome: BetOutcome = snapshot.refundMode ? 'refunded' : payout > BigInt(0) ? 'won' : 'lost'

    return {
      market,
      betId: log.betId,
      side,
      stake: log.stake,
      lockedZ: log.lockedZ,
      currentZ: snapshot.currentZ,
      // Unclaimed + a nonzero payout (won or refund) is what actually shows in
      // the Claimable section; claimed or zero-payout (lost) bets go straight
      // to History — a losing bet's `claimed` flag never flips true on-chain
      // (claimPayout reverts before that write is committed), so it can only
      // ever land in History, never Claimable.
      status: !claimed && payout > BigInt(0) ? 'claimable' : outcome,
      outcome,
      payout,
      claimed,
    }
  })
}
