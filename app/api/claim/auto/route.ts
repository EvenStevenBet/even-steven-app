import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'node:crypto'
import type { Address } from 'viem'
import { serverPublicClient } from '@/lib/server-client'
import { marketAbi, factoryAbi } from '@/lib/contracts'
import { relayAccount, getRelayEthBalance, RELAY_MIN_ETH } from '@/lib/relay'
import { runClaim, V1_6_FACTORY } from '@/lib/claim'

// Auto-claim cron. Hourly via vercel.json; Vercel Cron sends GET with
// `Authorization: Bearer $CRON_SECRET`, and POST is accepted for manual runs.
// Off unless AUTO_CLAIM_ENABLED=true. Claims run server-side through the same
// runClaim() as POST /api/claim, so the relay key never leaves Vercel.

export const dynamic = 'force-dynamic'
export const maxDuration = 300

const MAX_CLAIMS_PER_RUN = 20
// Stop starting new claims with enough headroom for the last receipt wait (15s).
const SOFT_DEADLINE_MS = 240_000
// Errors after which no further claim in this run could succeed.
const STOP_RUN_ERRORS = new Set(['RelayUnderfunded', 'RelayNotConfigured', 'LockServiceUnavailable'])

function authorized(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return false
  const got = Buffer.from(request.headers.get('authorization') ?? '')
  const want = Buffer.from(`Bearer ${secret}`)
  return got.length === want.length && timingSafeEqual(got, want)
}

export async function GET(request: NextRequest) {
  return handle(request)
}

export async function POST(request: NextRequest) {
  return handle(request)
}

async function handle(request: NextRequest) {
  if (!authorized(request)) {
    return NextResponse.json({ error: 'Unauthorized', message: 'missing or wrong CRON_SECRET bearer token' }, { status: 401 })
  }
  try {
    return NextResponse.json(await run())
  } catch (err) {
    console.error('[api/claim/auto] run failed', err)
    return NextResponse.json({ error: 'InternalError', message: 'auto-claim run failed' }, { status: 500 })
  }
}

type Claimed = { marketAddress: Address; bettor: Address; betIds: string[]; amount: string; txHash: string }
type Failed = { marketAddress: Address; bettor: Address; error: string; message: string; txHash?: unknown }

async function run() {
  if (process.env.AUTO_CLAIM_ENABLED !== 'true') {
    return { skipped: 'AUTO_CLAIM_ENABLED is not "true"', claims: [] }
  }
  if (!relayAccount) {
    console.error('[api/claim/auto] RELAY_PRIVATE_KEY not set — skipping run')
    return { skipped: 'RelayNotConfigured', claims: [] }
  }
  const relayBalance = await getRelayEthBalance()
  if (relayBalance < RELAY_MIN_ETH) {
    console.error(`[api/claim/auto] RelayUnderfunded: ${relayAccount.address} holds ${relayBalance} wei, minimum ${RELAY_MIN_ETH} — skipping run`)
    return { skipped: 'RelayUnderfunded', claims: [] }
  }

  const started = Date.now()

  // 1. Settled or canceled v1.6 markets still inside their claim window
  const markets = await serverPublicClient.readContract({
    address: V1_6_FACTORY, abi: factoryAbi, functionName: 'getAllMarkets',
  })
  const states = await serverPublicClient.multicall({
    contracts: markets.flatMap((address) => [
      { address, abi: marketAbi, functionName: 'getMarketState' } as const,
      { address, abi: marketAbi, functionName: 'getMarketStatus' } as const,
      { address, abi: marketAbi, functionName: 'MAX_BETS' } as const,
    ]),
    allowFailure: false,
  })
  const nowSeconds = BigInt(Math.floor(Date.now() / 1000))
  const finished: { market: Address; betCount: number }[] = []
  markets.forEach((market, i) => {
    const [, , , , , , isSettled] = states[i * 3] as readonly [string, bigint, bigint, bigint, bigint, boolean, boolean]
    const [isCanceled, , , claimDeadline, betsRemaining] = states[i * 3 + 1] as readonly [boolean, boolean, boolean, bigint, bigint]
    const maxBets = states[i * 3 + 2] as bigint
    if (!isSettled && !isCanceled) return
    // claimDeadline is 0 for a canceled market; the per-bet simulation catches an expired refund window.
    if (claimDeadline !== BigInt(0) && claimDeadline <= nowSeconds) return
    finished.push({ market, betCount: Number(maxBets - betsRemaining) })
  })

  // 2. Bettors holding at least one unclaimed bet, read straight from bets[]
  const candidates: { market: Address; bettor: Address }[] = []
  for (const { market, betCount } of finished) {
    if (betCount === 0) continue
    const bets = await serverPublicClient.multicall({
      contracts: Array.from({ length: betCount }, (_, id) => (
        { address: market, abi: marketAbi, functionName: 'getBet', args: [BigInt(id)] } as const
      )),
      allowFailure: false,
    })
    const bettors = new Set<Address>()
    for (const bet of bets) if (!bet.claimed) bettors.add(bet.bettor)
    for (const bettor of bettors) candidates.push({ market, bettor })
  }

  // 3. Claim, one relayed transaction per market + bettor, up to the cap
  const claims: Claimed[] = []
  const errors: Failed[] = []
  let stoppedBy: string | null = null
  for (const { market, bettor } of candidates) {
    if (claims.length >= MAX_CLAIMS_PER_RUN) { stoppedBy = 'MaxClaimsPerRun'; break }
    if (Date.now() - started > SOFT_DEADLINE_MS) { stoppedBy = 'TimeBudget'; break }

    const outcome = await runClaim(market, bettor, '[api/claim/auto]')
    if (outcome.kind === 'claimed') {
      claims.push({
        marketAddress: market, bettor, betIds: outcome.betIds.map(String),
        amount: outcome.amount.toString(), txHash: outcome.txHash,
      })
    } else if (outcome.kind === 'error') {
      // ClaimInFlight just means POST /api/claim got there first.
      if (outcome.error !== 'ClaimInFlight') {
        errors.push({ marketAddress: market, bettor, error: outcome.error, message: outcome.message, txHash: outcome.details?.txHash })
      }
      if (STOP_RUN_ERRORS.has(outcome.error)) { stoppedBy = outcome.error; break }
    }
  }

  const summary = {
    scannedMarkets: markets.length,
    finishedMarkets: finished.length,
    candidates: candidates.length,
    claims,
    errors,
    stoppedBy,
    durationMs: Date.now() - started,
  }
  console.log('[api/claim/auto] run complete', JSON.stringify(summary))
  return summary
}
