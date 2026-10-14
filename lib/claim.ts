import {
  BaseError,
  ContractFunctionRevertedError,
  parseEventLogs,
  type Address,
  type Hash,
} from 'viem'
import { serverPublicClient } from '@/lib/server-client'
import { marketAbi, factoryAbi, erc20Abi, V1_6_FACTORY } from '@/lib/contracts'
import { relayAccount, relayWalletClient, getRelayEthBalance, RELAY_MIN_ETH } from '@/lib/relay'
import { acquireClaimLock, refreshClaimLock, releaseClaimLock, CLAIM_LOCK_TTL_SECONDS } from '@/lib/claim-abuse'
import { attributionSuffix } from '@/lib/attribution'

// Server-side only. Relayed, gasless claiming via SportsbookMarket v1.11
// claimPayoutFor(bettor, betIds): permissionless, pays only bet.bettor, and
// reverts the whole call if any id is unclaimable. The relay pays gas and is
// never a party to a USDC transfer — the market pays the bettor directly.
// Shared by POST /api/claim and the auto-claim cron.

export { V1_6_FACTORY }
const USDC: Address = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const RECEIPT_TIMEOUT_MS = 15_000

// claimPayoutFor has no batch cap of its own (only MAX_BETS = 1000 per market),
// so a request claims at most CLAIM_MAX_CHUNKS sequential transactions of
// CLAIM_CHUNK_SIZE bets and reports the rest as remainingCount.
export const CLAIM_CHUNK_SIZE = 25
export const CLAIM_MAX_CHUNKS = 8
// Worst case for one chunk: simulate, balance read, submit, then the receipt wait.
export const CLAIM_CHUNK_BUDGET_MS = RECEIPT_TIMEOUT_MS + 10_000
const RELAY_BUSY_RETRY_SECONDS = 5

type ClaimFailure = { kind: 'error'; status: number; error: string; message: string; details?: Record<string, unknown> }

export type ClaimOutcome =
  | {
      kind: 'claimed'
      betIds: bigint[]        // every id this request claimed, across chunks
      amount: bigint          // total USDC paid to the bettor
      txHashes: Hash[]        // one per mined chunk, in order
      txHash: Hash            // the last of txHashes
      relay: Address
      blockNumber: bigint     // of the last chunk
      remainingCount: number  // claimable ids this request did not claim
      // Set when a chunk after the first failed; the earlier chunks stand.
      incomplete?: { error: string; message: string; details?: Record<string, unknown> }
    }
  | { kind: 'nothing' }
  | ClaimFailure

function failure(status: number, error: string, message: string, details?: Record<string, unknown>): ClaimFailure {
  return { kind: 'error', status, error, message, details }
}

function revertName(err: unknown): string | null {
  const reverted = err instanceof BaseError ? err.walk((e) => e instanceof ContractFunctionRevertedError) : null
  if (!(reverted instanceof ContractFunctionRevertedError)) return null
  return reverted.data?.errorName ?? reverted.reason ?? 'unknown'
}

function isNonceCollision(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /nonce too low|nonce has already been used|replacement transaction underpriced/i.test(msg)
}

/** Empty string when the market was not created by Factory v1.6. */
export async function v16GameId(market: Address): Promise<string> {
  return serverPublicClient.readContract({
    address: V1_6_FACTORY, abi: factoryAbi, functionName: 'gameIdByMarket', args: [market],
  })
}

/**
 * The bettor's unclaimed bet ids that claimPayoutFor would pay right now,
 * each simulated alone from the relay so one bad id cannot hide the others.
 * Losing bets (NoPayout), an unsettled market (NotSettledYet) and an expired
 * window (ClaimWindowExpired) all drop out here. Throws on RPC failure.
 */
export async function findClaimableBetIds(market: Address, bettor: Address, relay: Address): Promise<bigint[]> {
  const ids = await serverPublicClient.readContract({
    address: market, abi: marketAbi, functionName: 'getBetsByAddress', args: [bettor],
  })
  if (ids.length === 0) return []

  const bets = await serverPublicClient.multicall({
    contracts: ids.map((id) => ({ address: market, abi: marketAbi, functionName: 'getBet' as const, args: [id] as const })),
    allowFailure: false,
  })
  const unclaimed = ids.filter((_, i) => !bets[i].claimed && bets[i].bettor.toLowerCase() === bettor.toLowerCase())

  const results = await Promise.all(unclaimed.map(async (id) => {
    try {
      await serverPublicClient.simulateContract({
        address: market, abi: marketAbi, functionName: 'claimPayoutFor', args: [bettor, [id]], account: relay,
      })
      return id
    } catch (err) {
      if (revertName(err) === null) throw err
      return null
    }
  }))
  return results.filter((id): id is bigint => id !== null)
}

type ChunkResult =
  | { ok: true; txHash: Hash; amount: bigint; blockNumber: bigint }
  // inFlight: a transaction may still land, so the lock must be kept.
  | { ok: false; inFlight: boolean; failure: ClaimFailure }

/** Simulates, submits and verifies one claimPayoutFor for ids. Never throws. */
async function claimChunk(market: Address, bettor: Address, ids: bigint[], log: string): Promise<ChunkResult> {
  const relay = relayAccount!.address
  const stop = (inFlight: boolean, f: ClaimFailure): ChunkResult => ({ ok: false, inFlight, failure: f })

  // a. Simulate the exact batch from the relay
  let submit: () => Promise<Hash>
  try {
    const { request: tx } = await serverPublicClient.simulateContract({
      address: market, abi: marketAbi, functionName: 'claimPayoutFor', args: [bettor, ids], account: relayAccount!,
      dataSuffix: attributionSuffix(), // Even Steven's Base builder code; the market ignores it
    })
    submit = () => relayWalletClient!.writeContract(tx)
  } catch (err) {
    const name = revertName(err)
    if (name === null) {
      console.error(`${log} batch simulation failed without a revert`, err)
      return stop(false, failure(502, 'RpcError', 'could not simulate the claim against the chain'))
    }
    return stop(false, failure(409, name, `market rejected the claim: ${name}`))
  }

  // b. Never submit from an underfunded relay
  let relayBalance: bigint
  try {
    relayBalance = await getRelayEthBalance()
  } catch (err) {
    console.error(`${log} relay balance read failed`, err)
    return stop(false, failure(502, 'RpcError', 'could not read the relay balance'))
  }
  if (relayBalance < RELAY_MIN_ETH) {
    console.error(`${log} RelayUnderfunded: ${relay} holds ${relayBalance} wei, minimum ${RELAY_MIN_ETH}`)
    return stop(false, failure(503, 'RelayUnderfunded', 'relay wallet is below its ETH gas threshold; try again later'))
  }

  // c. Submit. The relay also sends POST /api/bet transactions, so a concurrent
  //    bet can take the nonce viem picked; retry once with a fresh one. A
  //    second collision means the node rejected the tx, so nothing is in flight.
  let txHash: Hash
  try {
    try {
      txHash = await submit()
    } catch (err) {
      if (!isNonceCollision(err)) throw err
      console.warn(`${log} relay nonce collision, retrying once`, err instanceof Error ? err.message : err)
      txHash = await submit()
    }
  } catch (err) {
    if (isNonceCollision(err)) {
      console.warn(`${log} relay nonce collision again — RelayBusy`)
      return stop(false, failure(409, 'RelayBusy', 'relay is busy with another transaction; nothing was submitted, retry shortly',
        { retryAfterSeconds: RELAY_BUSY_RETRY_SECONDS }))
    }
    console.error(`${log} submission failed`, err)
    return stop(true, failure(502, 'SubmissionFailed', err instanceof BaseError ? err.shortMessage : 'failed to submit transaction'))
  }
  console.log(`${log} submitted claimPayoutFor`, { market, bettor, betIds: ids.map(String), txHash })

  let receipt
  try {
    receipt = await serverPublicClient.waitForTransactionReceipt({ hash: txHash, timeout: RECEIPT_TIMEOUT_MS })
  } catch {
    return stop(true, failure(504, 'SubmissionPending', 'transaction submitted but not yet mined; check txHash', { txHash }))
  }
  if (receipt.status !== 'success') {
    // Mined and reverted: nothing is in flight any more.
    console.error(`${log} SubmissionReverted ${txHash}`)
    return stop(false, failure(502, 'SubmissionReverted', 'claim transaction reverted on-chain', { txHash }))
  }

  // d. Non-custodial invariants: one BetClaimed per id for this bettor, one
  //    PayoutClaimed to this bettor, the USDC went market -> bettor, and the
  //    relay touched no USDC.
  const marketLogs = receipt.logs.filter((l) => l.address.toLowerCase() === market.toLowerCase())
  const betClaimed = parseEventLogs({ abi: marketAbi, eventName: 'BetClaimed', logs: marketLogs })
  const payoutClaimed = parseEventLogs({ abi: marketAbi, eventName: 'PayoutClaimed', logs: marketLogs })
  const usdcTransfers = parseEventLogs({
    abi: erc20Abi,
    eventName: 'Transfer',
    logs: receipt.logs.filter((l) => l.address.toLowerCase() === USDC.toLowerCase()),
  })

  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
  const claimedIds = new Set(betClaimed.map((e) => e.args.betId))
  const amount = payoutClaimed[0]?.args.amount ?? BigInt(0)
  const ok =
    betClaimed.length === ids.length &&
    ids.every((id) => claimedIds.has(id)) &&
    betClaimed.every((e) => same(e.args.bettor, bettor)) &&
    payoutClaimed.length === 1 &&
    same(payoutClaimed[0].args.bettor, bettor) &&
    betClaimed.reduce((sum, e) => sum + e.args.payout, BigInt(0)) === amount &&
    usdcTransfers.some((t) => same(t.args.from, market) && same(t.args.to, bettor) && t.args.value === amount) &&
    !usdcTransfers.some((t) => same(t.args.from, relay) || same(t.args.to, relay))

  if (!ok) {
    console.error(`${log} CUSTODY INVARIANT VIOLATED`, {
      txHash, market, bettor, relay, betIds: ids.map(String),
      betClaimed: betClaimed.map((e) => ({ bettor: e.args.bettor, betId: String(e.args.betId), payout: String(e.args.payout) })),
      payoutClaimed: payoutClaimed.map((e) => ({ bettor: e.args.bettor, amount: String(e.args.amount) })),
      usdcTransfers: usdcTransfers.map((t) => ({ from: t.args.from, to: t.args.to, value: String(t.args.value) })),
    })
    return stop(true, failure(500, 'CustodyInvariantViolated', 'claim receipt does not match the requested bettor', { txHash }))
  }

  console.log(`${log} claimed`, { market, bettor, amount: String(amount), txHash })
  return { ok: true, txHash, amount, blockNumber: receipt.blockNumber }
}

/**
 * Finds everything claimable for bettor on a v1.11 market and claims it in up
 * to CLAIM_MAX_CHUNKS sequential relayed claimPayoutFor transactions of
 * CLAIM_CHUNK_SIZE bets, holding the claim:{market}:{bettor} lock for the
 * whole request. No chunk starts unless it can finish before deadline (ms).
 * Chunks already mined stand when a later one fails. The lock is released when
 * the request ends with nothing in flight, and otherwise kept until it expires.
 */
export async function runClaim(market: Address, bettor: Address, log: string, deadline: number): Promise<ClaimOutcome> {
  if (!relayAccount || !relayWalletClient) {
    console.error(`${log} RELAY_PRIVATE_KEY not set — refusing to submit`)
    return failure(503, 'RelayNotConfigured', 'relay wallet is not configured')
  }
  const relay = relayAccount.address

  // 1. Only Factory v1.6 markets have claimPayoutFor
  if ((await v16GameId(market)) === '') {
    const code = await serverPublicClient.getCode({ address: market })
    if (!code || code === '0x') return failure(404, 'MarketNotFound', `no contract at ${market}`)
    return failure(409, 'UnsupportedMarket',
      'market was not created by SportsbookFactory v1.6; only v1.11 markets support relayed claiming',
      { factory: V1_6_FACTORY })
  }

  // 2. Claimable set
  let betIds: bigint[]
  try {
    betIds = await findClaimableBetIds(market, bettor, relay)
  } catch (err) {
    console.error(`${log} reading claimable bets failed`, err)
    return failure(502, 'RpcError', 'could not read the bettor\'s bets from the chain')
  }
  if (betIds.length === 0) return { kind: 'nothing' }

  // 3. In-flight lock for the whole request, fail closed
  try {
    if (!(await acquireClaimLock(market, bettor))) {
      return failure(409, 'ClaimInFlight',
        'a claim for this bettor on this market is in flight or was submitted recently; nothing was submitted',
        { lockSeconds: CLAIM_LOCK_TTL_SECONDS })
    }
  } catch (err) {
    console.error(`${log} lock store unavailable — refusing to submit`, err)
    return failure(503, 'LockServiceUnavailable', 'claim lock service is unavailable; nothing was submitted')
  }

  // 4. Chunks, one at a time
  const chunks: bigint[][] = []
  for (let i = 0; i < betIds.length && chunks.length < CLAIM_MAX_CHUNKS; i += CLAIM_CHUNK_SIZE) {
    chunks.push(betIds.slice(i, i + CLAIM_CHUNK_SIZE))
  }
  const claimed: bigint[] = []
  const txHashes: Hash[] = []
  let amount = BigInt(0)
  let blockNumber = BigInt(0)
  let stopped: Extract<ChunkResult, { ok: false }> | null = null

  for (const [i, ids] of chunks.entries()) {
    if (i > 0) {
      if (Date.now() + CLAIM_CHUNK_BUDGET_MS > deadline) break
      try {
        await refreshClaimLock(market, bettor)
      } catch (err) {
        console.error(`${log} lock store unavailable mid-claim — stopping`, err)
        stopped = { ok: false, inFlight: false, failure: failure(503, 'LockServiceUnavailable',
          'claim lock service became unavailable; later chunks were not submitted') }
        break
      }
    }
    const result = await claimChunk(market, bettor, ids, log)
    if (!result.ok) { stopped = result; break }
    claimed.push(...ids)
    txHashes.push(result.txHash)
    amount += result.amount
    blockNumber = result.blockNumber
  }

  if (!stopped?.inFlight) await releaseClaimLock(market, bettor)

  if (stopped && (claimed.length === 0 || stopped.failure.error === 'CustodyInvariantViolated')) {
    const f = stopped.failure
    return claimed.length === 0
      ? f
      : failure(f.status, f.error, f.message, { ...f.details, txHashes, claimedCount: claimed.length })
  }
  const f = stopped?.failure
  return {
    kind: 'claimed',
    betIds: claimed,
    amount,
    txHashes,
    txHash: txHashes[txHashes.length - 1],
    relay,
    blockNumber,
    remainingCount: betIds.length - claimed.length,
    ...(f ? { incomplete: { error: f.error, message: f.message, details: f.details } } : {}),
  }
}
