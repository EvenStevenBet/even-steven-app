import { NextRequest, NextResponse } from 'next/server'
import { getAddress, isAddress, zeroAddress } from 'viem'
import { runClaim } from '@/lib/claim'
import { clientIp, consumeClaimRateLimit, CLAIM_RATE_LIMIT_PER_MINUTE } from '@/lib/claim-abuse'

export const dynamic = 'force-dynamic'
// Up to CLAIM_MAX_CHUNKS sequential transactions; runClaim starts no chunk it
// cannot finish inside DEADLINE_MS.
export const maxDuration = 120
const DEADLINE_MS = (maxDuration - 10) * 1000

function fail(status: number, error: string, message: string, details: Record<string, unknown> = {}) {
  return NextResponse.json({ error, message, ...details }, { status })
}

function invalid(field: string, message: string) {
  return fail(400, 'InvalidRequest', message, { field })
}

export async function POST(request: NextRequest) {
  try {
    return await handle(request)
  } catch (err) {
    console.error('[api/claim] unhandled error', err)
    return fail(500, 'InternalError', 'unexpected server error')
  }
}

async function handle(request: NextRequest) {
  const started = Date.now()
  // No x402 gate: claiming is free; the relay pays the gas.
  // 0. Per-IP rate limit, fail closed
  const ip = clientIp(request)
  try {
    const rl = await consumeClaimRateLimit(ip)
    if (rl.limited) {
      return fail(429, 'RateLimited', `more than ${CLAIM_RATE_LIMIT_PER_MINUTE} requests per minute from this IP`,
        { retryAfterSeconds: rl.retryAfterSeconds })
    }
  } catch (err) {
    console.error('[api/claim] lock store unavailable — refusing to submit', err)
    return fail(503, 'LockServiceUnavailable', 'claim lock service is unavailable; nothing was submitted')
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
  if (typeof body.marketAddress !== 'string' || !isAddress(body.marketAddress)) {
    return invalid('marketAddress', 'marketAddress must be a valid address')
  }
  if (typeof body.bettor !== 'string' || !isAddress(body.bettor)) return invalid('bettor', 'bettor must be a valid address')

  const marketAddress = getAddress(body.marketAddress)
  const bettor = getAddress(body.bettor)
  if (bettor === zeroAddress) return fail(400, 'InvalidBettor', 'bettor cannot be the zero address')

  // 2. Everything else — market check, claimable set, lock, submission, receipt checks
  const outcome = await runClaim(marketAddress, bettor, '[api/claim]', started + DEADLINE_MS)
  if (outcome.kind === 'error') return fail(outcome.status, outcome.error, outcome.message, outcome.details)
  if (outcome.kind === 'nothing') {
    return NextResponse.json({ claimed: [], note: 'Nothing claimable', txHashes: [], claimedCount: 0, remainingCount: 0 })
  }

  return NextResponse.json({
    success: true,
    bettor,
    marketAddress,
    betIds: outcome.betIds.map(String),
    amount: outcome.amount.toString(),
    txHashes: outcome.txHashes,
    txHash: outcome.txHash,
    claimedCount: outcome.betIds.length,
    remainingCount: outcome.remainingCount,
    relay: outcome.relay,
    ...(outcome.incomplete ? { incomplete: { ...outcome.incomplete.details, error: outcome.incomplete.error, message: outcome.incomplete.message } } : {}),
  })
}
