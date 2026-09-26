import { NextRequest, NextResponse } from 'next/server'
import {
  BaseError,
  ContractFunctionRevertedError,
  encodeAbiParameters,
  getAddress,
  isAddress,
  isHex,
  keccak256,
  parseEventLogs,
  size,
  slice,
  hexToNumber,
  zeroAddress,
  type Address,
  type Hash,
  type Hex,
} from 'viem'
import { serverPublicClient } from '@/lib/server-client'
import { marketAbi, factoryAbi, erc20Abi } from '@/lib/contracts'
import { formatZDisplay } from '@/lib/format'
import { relayAccount, relayWalletClient, getRelayEthBalance, RELAY_MIN_ETH } from '@/lib/relay'
import {
  acquireLock, clientIp, consumeRateLimit, recordStrike, releaseLock, strikeCounts,
  LOCK_TTL_SECONDS, MAX_STRIKES, RATE_LIMIT_PER_MINUTE,
} from '@/lib/abuse'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

// Pinned rather than read from NEXT_PUBLIC_FACTORY_ADDRESS: only markets from
// this factory are SportsbookMarket v1.11 (its MarketDeployer is immutable),
// and the placeBetFor ABI below is exactly v1.11's.
const V1_6_FACTORY: Address = '0x5906370b9831728ec523b647137a1bbf0ab45390'
const USDC: Address = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
// Read on-chain 2026-09-24 (name(), version()) and confirmed by recomputing
// DOMAIN_SEPARATOR 0x02fa7265…834f on chain 8453.
const USDC_EIP712_DOMAIN = { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: USDC } as const

const MIN_STAKE = BigInt(1_000_000)
const MIN_VALIDITY_SECONDS = BigInt(30)
const UINT256_MAX = (BigInt(1) << BigInt(256)) - BigInt(1)
const BYTES32 = /^0x[0-9a-fA-F]{64}$/
const RECEIPT_TIMEOUT_MS = 15_000

function fail(status: number, error: string, message: string, details: Record<string, unknown> = {}) {
  return NextResponse.json({ error, message, ...details }, { status })
}

function invalid(field: string, message: string) {
  return fail(400, 'InvalidRequest', message, { field })
}

function parseUint(value: unknown): bigint | null {
  if (typeof value !== 'string' || !/^\d{1,78}$/.test(value)) return null
  const n = BigInt(value)
  return n <= UINT256_MAX ? n : null
}

const CONFLICT_ERRORS = new Set(['BettingIsClosed', 'MarketEnded', 'MarketFull', 'MarketPaused', 'FeeTransferFailed'])
const BAD_REQUEST_ERRORS = new Set(['BelowMinBet', 'InvalidBettor', 'BadAuthorizationNonce'])

// FiatTokenV2_2 revert strings (verified USDC implementation
// 0x2Ce6311ddAE708829bc0784C967b7d77D19FD779), bubbled up through the market.
const USDC_REASONS: [RegExp, string][] = [
  [/invalid signature/i, 'InvalidSignature'],
  [/authorization is used or canceled/i, 'AuthorizationUsedOrCanceled'],
  [/authorization is not yet valid/i, 'AuthorizationNotYetValid'],
  [/authorization is expired/i, 'AuthorizationExpired'],
  [/transfer amount exceeds balance/i, 'InsufficientUsdcBalance'],
  [/blacklisted/i, 'AccountBlacklisted'],
  [/^Pausable: paused$/, 'UsdcPaused'],
]

// Fail closed: without the lock store the relay cannot guarantee one submission per authorization.
function lockServiceUnavailable(err: unknown) {
  console.error('[api/bet] lock store unavailable — refusing to submit', err)
  return fail(503, 'LockServiceUnavailable', 'bet lock service is unavailable; nothing was submitted')
}

function isNonceCollision(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /nonce too low|nonce has already been used|replacement transaction underpriced/i.test(msg)
}

export async function POST(request: NextRequest) {
  try {
    return await handle(request)
  } catch (err) {
    console.error('[api/bet] unhandled error', err)
    return fail(500, 'InternalError', 'unexpected server error')
  }
}

async function handle(request: NextRequest) {
  // No x402 gate: the only fee is the contract's 2% taker fee, taken at placement.
  // 0. Per-IP rate limit
  const ip = clientIp(request)
  try {
    const rl = await consumeRateLimit(ip)
    if (rl.limited) {
      return fail(429, 'RateLimited', `more than ${RATE_LIMIT_PER_MINUTE} requests per minute from this IP`,
        { retryAfterSeconds: rl.retryAfterSeconds })
    }
  } catch (err) {
    return lockServiceUnavailable(err)
  }

  // 1. Shape validation
  let body: Record<string, unknown>
  try {
    const parsed = await request.json()
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error()
    body = parsed
  } catch {
    return invalid('body', 'request body must be a JSON object')
  }

  const hasMarket = body.marketAddress !== undefined
  const hasGameId = body.gameId !== undefined
  if (hasMarket === hasGameId) return invalid('marketAddress', 'provide exactly one of marketAddress or gameId')
  if (hasMarket && (typeof body.marketAddress !== 'string' || !isAddress(body.marketAddress))) {
    return invalid('marketAddress', 'marketAddress must be a valid address')
  }
  if (hasGameId && (typeof body.gameId !== 'string' || body.gameId.length === 0)) {
    return invalid('gameId', 'gameId must be a non-empty string')
  }
  if (typeof body.bettor !== 'string' || !isAddress(body.bettor)) return invalid('bettor', 'bettor must be a valid address')
  if (typeof body.greaterThan !== 'boolean') return invalid('greaterThan', 'greaterThan must be a boolean')
  const stake = parseUint(body.stake)
  if (stake === null) return invalid('stake', 'stake must be a uint256 decimal string in 6-decimal base units')
  const validAfter = parseUint(body.validAfter)
  if (validAfter === null) return invalid('validAfter', 'validAfter must be a uint256 decimal string (unix seconds)')
  const validBefore = parseUint(body.validBefore)
  if (validBefore === null) return invalid('validBefore', 'validBefore must be a uint256 decimal string (unix seconds)')
  if (typeof body.nonce !== 'string' || !BYTES32.test(body.nonce)) return invalid('nonce', 'nonce must be a 0x-prefixed bytes32')
  if (typeof body.salt !== 'string' || !BYTES32.test(body.salt)) return invalid('salt', 'salt must be a 0x-prefixed bytes32')
  if (typeof body.signature !== 'string' || !isHex(body.signature, { strict: true }) || body.signature.length % 2 !== 0 || body.signature.length <= 2) {
    return invalid('signature', 'signature must be non-empty 0x-prefixed hex bytes')
  }

  const bettor = getAddress(body.bettor)
  if (bettor === zeroAddress) return fail(400, 'InvalidBettor', 'bettor cannot be the zero address')
  const greaterThan = body.greaterThan
  const nonce = body.nonce as Hash
  const salt = body.salt as Hash
  const signature = body.signature as Hex

  // 2. Resolve the market — must be a SportsbookFactory v1.6 market
  let marketAddress: Address
  let gameId: string
  if (hasMarket) {
    marketAddress = getAddress(body.marketAddress as string)
    gameId = await serverPublicClient.readContract({
      address: V1_6_FACTORY, abi: factoryAbi, functionName: 'gameIdByMarket', args: [marketAddress],
    })
    if (gameId === '') {
      const code = await serverPublicClient.getCode({ address: marketAddress })
      if (!code || code === '0x') return fail(404, 'MarketNotFound', `no contract at ${marketAddress}`)
      return fail(409, 'UnsupportedMarket',
        'market was not created by SportsbookFactory v1.6; only v1.11 markets support relayed betting',
        { factory: V1_6_FACTORY })
    }
  } else {
    gameId = body.gameId as string
    marketAddress = await serverPublicClient.readContract({
      address: V1_6_FACTORY, abi: factoryAbi, functionName: 'marketByGameId', args: [gameId],
    })
    if (marketAddress === zeroAddress) {
      return fail(404, 'MarketNotFound', `no SportsbookFactory v1.6 market for gameId "${gameId}"`, { factory: V1_6_FACTORY })
    }
  }

  // 3. Local checks — the same rules the contract and USDC enforce, failed fast
  const expectedNonce = keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'bool' }], [salt, greaterThan]))
  if (nonce.toLowerCase() !== expectedNonce) {
    return fail(400, 'BadAuthorizationNonce', 'nonce must equal keccak256(abi.encode(salt, greaterThan))', { expectedNonce })
  }
  if (stake < MIN_STAKE) return fail(400, 'BelowMinBet', 'stake must be at least 1000000 (1 USDC)', { minStake: MIN_STAKE.toString() })
  const now = BigInt(Math.floor(Date.now() / 1000))
  if (validBefore <= now + MIN_VALIDITY_SECONDS) {
    return fail(400, 'AuthorizationExpired', `validBefore must be more than ${MIN_VALIDITY_SECONDS}s in the future`,
      { validBefore: validBefore.toString(), now: now.toString() })
  }

  if (!relayAccount || !relayWalletClient) {
    console.error('[api/bet] RELAY_PRIVATE_KEY not set — refusing to submit')
    return fail(503, 'RelayNotConfigured', 'relay wallet is not configured')
  }
  const relay = relayAccount.address

  // 4. Strike check, then the in-flight lock. Every exit before submission releases it.
  try {
    const strikes = await strikeCounts(bettor, ip)
    if (strikes.bettor >= MAX_STRIKES || strikes.ip >= MAX_STRIKES) {
      return fail(429, 'TooManyFailedSubmissions',
        `${MAX_STRIKES} of this bettor's or this IP's submissions reverted on-chain in the last 24 hours`,
        { maxStrikes: MAX_STRIKES })
    }
    if (!(await acquireLock(bettor, nonce))) {
      return fail(409, 'DuplicateSubmission',
        'this authorization (bettor + nonce) is already in flight or was submitted recently; nothing was submitted',
        { lockSeconds: LOCK_TTL_SECONDS })
    }
  } catch (err) {
    return lockServiceUnavailable(err)
  }

  // 5. Route by signature shape and simulate from the relay with the exact args
  const common = { address: marketAddress, abi: marketAbi, account: relayAccount } as const
  let submit: () => Promise<Hash>
  try {
    if (size(signature) === 65) {
      let v = hexToNumber(slice(signature, 64, 65))
      if (v < 27) v += 27
      const auth = { validAfter, validBefore, nonce, salt, v, r: slice(signature, 0, 32), s: slice(signature, 32, 64) }
      const { request: tx } = await serverPublicClient.simulateContract({
        ...common, functionName: 'placeBetFor', args: [bettor, greaterThan, stake, auth],
      })
      submit = () => relayWalletClient!.writeContract(tx)
    } else {
      const auth = { validAfter, validBefore, nonce, salt, signature }
      const { request: tx } = await serverPublicClient.simulateContract({
        ...common, functionName: 'placeBetForWithSignature', args: [bettor, greaterThan, stake, auth],
      })
      submit = () => relayWalletClient!.writeContract(tx)
    }
  } catch (err) {
    await releaseLock(bettor, nonce)
    return simulationFailure(err, { marketAddress, bettor, stake, validAfter, validBefore, nonce })
  }

  // 6. Never submit from an underfunded relay
  let relayBalance: bigint
  try {
    relayBalance = await getRelayEthBalance()
  } catch (err) {
    await releaseLock(bettor, nonce)
    throw err
  }
  if (relayBalance < RELAY_MIN_ETH) {
    await releaseLock(bettor, nonce)
    console.error(`[api/bet] RelayUnderfunded: ${relay} holds ${relayBalance} wei, minimum ${RELAY_MIN_ETH}`)
    return fail(503, 'RelayUnderfunded', 'relay wallet is below its ETH gas threshold; try again later')
  }

  // 7. Submit, retrying once on a relay nonce collision (concurrent invocations).
  // From here on the lock is kept until it expires: the authorization is in flight, spent, or (after a revert) still valid.
  let txHash: Hash
  try {
    try {
      txHash = await submit()
    } catch (err) {
      if (!isNonceCollision(err)) throw err
      console.warn('[api/bet] relay nonce collision, retrying once', err instanceof Error ? err.message : err)
      txHash = await submit()
    }
  } catch (err) {
    console.error('[api/bet] submission failed', err)
    return fail(502, 'SubmissionFailed', err instanceof BaseError ? err.shortMessage : 'failed to submit transaction')
  }

  let receipt
  try {
    receipt = await serverPublicClient.waitForTransactionReceipt({ hash: txHash, timeout: RECEIPT_TIMEOUT_MS })
  } catch {
    return fail(504, 'SubmissionPending', 'transaction submitted but not yet mined; check txHash', { txHash })
  }
  if (receipt.status !== 'success') {
    console.error(`[api/bet] SubmissionReverted ${txHash}`)
    await recordStrike(bettor, ip)
    return fail(502, 'SubmissionReverted', 'bet transaction reverted on-chain', { txHash })
  }

  // 8. Decode BetPlaced and assert the non-custodial invariants
  const betEvents = parseEventLogs({
    abi: marketAbi,
    eventName: 'BetPlaced',
    logs: receipt.logs.filter((l) => l.address.toLowerCase() === marketAddress.toLowerCase()),
  })
  const relayTouchedUsdc = parseEventLogs({
    abi: erc20Abi,
    eventName: 'Transfer',
    logs: receipt.logs.filter((l) => l.address.toLowerCase() === USDC.toLowerCase()),
  }).some((t) => t.args.from === relay || t.args.to === relay)

  if (betEvents.length !== 1 || betEvents[0].args.bettor.toLowerCase() !== bettor.toLowerCase() || relayTouchedUsdc) {
    console.error('[api/bet] CUSTODY INVARIANT VIOLATED', {
      txHash, bettor, relay, relayTouchedUsdc,
      betPlaced: betEvents.map((e) => ({ ...e.args, betId: e.args.betId.toString(), stake: e.args.stake.toString() })),
    })
    return fail(500, 'CustodyInvariantViolated', 'bet receipt does not match the requested bettor', { txHash })
  }

  const ev = betEvents[0].args
  return NextResponse.json({
    success: true,
    betId: ev.betId.toString(),
    bettor: ev.bettor,
    relay,
    marketAddress,
    gameId,
    greaterThan: ev.greaterThan,
    stake: ev.stake.toString(),
    fee: ev.fee.toString(),
    lockedZ: ev.lockedZ.toString(),
    lockedZDisplay: formatZDisplay(ev.lockedZ),
    txHash,
    blockNumber: receipt.blockNumber.toString(),
  })
}

async function simulationFailure(
  err: unknown,
  ctx: { marketAddress: Address; bettor: Address; stake: bigint; validAfter: bigint; validBefore: bigint; nonce: Hash },
) {
  const reverted = err instanceof BaseError ? err.walk((e) => e instanceof ContractFunctionRevertedError) : null
  if (!(reverted instanceof ContractFunctionRevertedError)) {
    console.error('[api/bet] simulation failed without a revert', err)
    return fail(502, 'RpcError', 'could not simulate the bet against the chain')
  }

  const errorName = reverted.data?.errorName
  if (errorName && CONFLICT_ERRORS.has(errorName)) return fail(409, errorName, `market rejected the bet: ${errorName}`)
  if (errorName && BAD_REQUEST_ERRORS.has(errorName)) return fail(400, errorName, `market rejected the bet: ${errorName}`)

  const revertReason = reverted.reason ?? ''
  const usdcReason = USDC_REASONS.find(([re]) => re.test(revertReason))?.[1]
  if (usdcReason) {
    const feeBps = await serverPublicClient.readContract({ address: ctx.marketAddress, abi: marketAbi, functionName: 'FEE_PERCENT' })
    const fee = (ctx.stake * feeBps) / BigInt(10_000)
    return fail(422, 'AuthorizationRejected', `USDC rejected the authorization: ${revertReason}`, {
      reason: usdcReason,
      usdcRevert: revertReason,
      expected: {
        primaryType: 'ReceiveWithAuthorization',
        domain: USDC_EIP712_DOMAIN,
        message: {
          from: ctx.bettor,
          to: ctx.marketAddress,
          value: (ctx.stake + fee).toString(),
          validAfter: ctx.validAfter.toString(),
          validBefore: ctx.validBefore.toString(),
          nonce: ctx.nonce,
        },
        stake: ctx.stake.toString(),
        fee: fee.toString(),
        feeBps: feeBps.toString(),
      },
    })
  }

  return fail(400, 'SimulationReverted', `bet simulation reverted: ${errorName ?? revertReason ?? 'unknown'}`, {
    errorName: errorName ?? null,
    reason: revertReason || null,
  })
}
