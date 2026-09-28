import { Redis } from '@upstash/redis'

// Server-side only. Abuse protection for POST /api/claim and the auto-claim
// cron, backed by the same Upstash Redis as lib/abuse.ts but under claim:*
// keys so claims never share a lock or a rate-limit budget with bets.
// Callers must treat any thrown error as "store unavailable" and fail closed.

export { clientIp } from '@/lib/abuse'

const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL
const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN
const redis = url && token ? new Redis({ url, token, retry: { retries: 1 } }) : null

export const CLAIM_LOCK_TTL_SECONDS = 300
export const CLAIM_RATE_LIMIT_PER_MINUTE = 10

function store(): Redis {
  if (!redis) throw new Error('Upstash Redis is not configured (KV_REST_API_URL / KV_REST_API_TOKEN)')
  return redis
}

const lockKey = (market: string, bettor: string) => `claim:${market.toLowerCase()}:${bettor.toLowerCase()}`

/** Fixed one-minute window per IP. Counts every request, valid or not. */
export async function consumeClaimRateLimit(ip: string): Promise<{ limited: boolean; retryAfterSeconds: number }> {
  const now = Math.floor(Date.now() / 1000)
  const key = `claim:rl:ip:${ip}:${Math.floor(now / 60)}`
  const [count] = await store().pipeline().incr(key).expire(key, 120).exec<[number, number]>()
  return { limited: count > CLAIM_RATE_LIMIT_PER_MINUTE, retryAfterSeconds: 60 - (now % 60) }
}

/**
 * SET NX: true only for the first caller claiming for this market + bettor.
 * Held for the full TTL after a submission, so a repeat request cannot send a
 * second transaction for the same bets while the first is in flight.
 */
export async function acquireClaimLock(market: string, bettor: string): Promise<boolean> {
  const res = await store().set(lockKey(market, bettor), Date.now(), { nx: true, ex: CLAIM_LOCK_TTL_SECONDS })
  return res === 'OK'
}

/** Only for failures before submission. A failed release just leaves the lock to expire. */
export async function releaseClaimLock(market: string, bettor: string): Promise<void> {
  try {
    await store().del(lockKey(market, bettor))
  } catch (err) {
    console.error('[claim] lock release failed; it will expire on its own', err)
  }
}
