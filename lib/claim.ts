import {
  BaseError,
  ContractFunctionRevertedError,
  parseEventLogs,
  type Address,
  type Hash,
} from 'viem'
import { serverPublicClient } from '@/lib/server-client'
import { marketAbi, factoryAbi, erc20Abi } from '@/lib/contracts'
import { relayAccount, relayWalletClient, getRelayEthBalance, RELAY_MIN_ETH } from '@/lib/relay'
import { acquireClaimLock, releaseClaimLock, CLAIM_LOCK_TTL_SECONDS } from '@/lib/claim-abuse'
import { attributionSuffix } from '@/lib/attribution'

// Server-side only. Relayed, gasless claiming via SportsbookMarket v1.11
// claimPayoutFor(bettor, betIds): permissionless, pays only bet.bettor, and
// reverts the whole call if any id is unclaimable. The relay pays gas and is
// never a party to a USDC transfer — the market pays the bettor directly.
// Shared by POST /api/claim and the auto-claim cron.

// Pinned rather than read from NEXT_PUBLIC_FACTORY_ADDRESS: only markets from
// this factory are SportsbookMarket v1.11 and expose claimPayoutFor.
export const V1_6_FACTORY: Address = '0x5906370b9831728ec523b647137a1bbf0ab45390'
const USDC: Address = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const RECEIPT_TIMEOUT_MS = 15_000

export type ClaimOutcome =
  | { kind: 'claimed'; betIds: bigint[]; amount: bigint; txHash: Hash; relay: Address; blockNumber: bigint }
  | { kind: 'nothing' }
  | { kind: 'error'; status: number; error: string; message: string; details?: Record<string, unknown> }

function failure(status: number, error: string, message: string, details?: Record<string, unknown>): ClaimOutcome {
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

/**
 * Finds everything claimable for bettor on a v1.11 market and claims it in one
 * relayed claimPayoutFor, holding the claim:{market}:{bettor} lock. The lock
 * is released on every exit before submission and kept after it.
 */
export async function runClaim(market: Address, bettor: Address, log = '[claim]'): Promise<ClaimOutcome> {
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

  // 3. In-flight lock, fail closed
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

  // 4. Simulate the exact batch from the relay
  let submit: () => Promise<Hash>
  try {
    const { request: tx } = await serverPublicClient.simulateContract({
      address: market, abi: marketAbi, functionName: 'claimPayoutFor', args: [bettor, betIds], account: relayAccount,
      dataSuffix: attributionSuffix(), // Even Steven's Base builder code; the market ignores it
    })
    submit = () => relayWalletClient!.writeContract(tx)
  } catch (err) {
    await releaseClaimLock(market, bettor)
    const name = revertName(err)
    if (name === null) {
      console.error(`${log} batch simulation failed without a revert`, err)
      return failure(502, 'RpcError', 'could not simulate the claim against the chain')
    }
    return failure(409, name, `market rejected the claim: ${name}`)
  }

  // 5. Never submit from an underfunded relay
  let relayBalance: bigint
  try {
    relayBalance = await getRelayEthBalance()
  } catch (err) {
    await releaseClaimLock(market, bettor)
    throw err
  }
  if (relayBalance < RELAY_MIN_ETH) {
    await releaseClaimLock(market, bettor)
    console.error(`${log} RelayUnderfunded: ${relay} holds ${relayBalance} wei, minimum ${RELAY_MIN_ETH}`)
    return failure(503, 'RelayUnderfunded', 'relay wallet is below its ETH gas threshold; try again later')
  }

  // 6. Submit. From here the lock is kept until it expires.
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
    console.error(`${log} submission failed`, err)
    return failure(502, 'SubmissionFailed', err instanceof BaseError ? err.shortMessage : 'failed to submit transaction')
  }
  console.log(`${log} submitted claimPayoutFor`, { market, bettor, betIds: betIds.map(String), txHash })

  let receipt
  try {
    receipt = await serverPublicClient.waitForTransactionReceipt({ hash: txHash, timeout: RECEIPT_TIMEOUT_MS })
  } catch {
    return failure(504, 'SubmissionPending', 'transaction submitted but not yet mined; check txHash', { txHash })
  }
  if (receipt.status !== 'success') {
    console.error(`${log} SubmissionReverted ${txHash}`)
    return failure(502, 'SubmissionReverted', 'claim transaction reverted on-chain', { txHash })
  }

  // 7. Non-custodial invariants: one BetClaimed per id for this bettor, one
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
    betClaimed.length === betIds.length &&
    betIds.every((id) => claimedIds.has(id)) &&
    betClaimed.every((e) => same(e.args.bettor, bettor)) &&
    payoutClaimed.length === 1 &&
    same(payoutClaimed[0].args.bettor, bettor) &&
    betClaimed.reduce((sum, e) => sum + e.args.payout, BigInt(0)) === amount &&
    usdcTransfers.some((t) => same(t.args.from, market) && same(t.args.to, bettor) && t.args.value === amount) &&
    !usdcTransfers.some((t) => same(t.args.from, relay) || same(t.args.to, relay))

  if (!ok) {
    console.error(`${log} CUSTODY INVARIANT VIOLATED`, {
      txHash, market, bettor, relay, betIds: betIds.map(String),
      betClaimed: betClaimed.map((e) => ({ bettor: e.args.bettor, betId: String(e.args.betId), payout: String(e.args.payout) })),
      payoutClaimed: payoutClaimed.map((e) => ({ bettor: e.args.bettor, amount: String(e.args.amount) })),
      usdcTransfers: usdcTransfers.map((t) => ({ from: t.args.from, to: t.args.to, value: String(t.args.value) })),
    })
    return failure(500, 'CustodyInvariantViolated', 'claim receipt does not match the requested bettor', { txHash })
  }

  console.log(`${log} claimed`, { market, bettor, amount: String(amount), txHash })
  return { kind: 'claimed', betIds, amount, txHash, relay, blockNumber: receipt.blockNumber }
}
