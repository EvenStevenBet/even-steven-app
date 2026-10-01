import { Redis } from '@upstash/redis'

// Server-side only. Rate limits for the x402-priced GET routes, backed by the
// same Upstash Redis as lib/abuse.ts under x402:* keys. Since a 4xx answer is
// never settled (lib/x402-server.ts withPayment), a replayed or junk X-PAYMENT
// would otherwise cost us a facilitator /verify and the handler's RPC reads
// for free.
//
// Two fixed one-minute windows: per IP (before verification), and per payer
// (after verification), so one valid signature replayed from many IPs is still
// capped without letting a forged header spend another payer's quota.
//
// Fails OPEN: these routes only read and never move funds (the facilitator
// verifies every payment), so a Redis outage should not take paid data down.

export { clientIp } from '@/lib/abuse'

const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL
const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN
const redis = url && token ? new Redis({ url, token, retry: { retries: 1 } }) : null

const configured = Number(process.env.X402_RATE_LIMIT_PER_MINUTE)
export const X402_RATE_LIMIT_PER_MINUTE = Number.isInteger(configured) && configured > 0 ? configured : 30

export type RateLimitResult = { limited: false } | { limited: true; retryAfterSeconds: number }

/** Fixed one-minute window on `key`. Fails open on any store error. */
async function consume(key: string): Promise<RateLimitResult> {
  if (!redis) {
    console.error('[x402] rate limit store not configured — allowing request')
    return { limited: false }
  }
  const now = Math.floor(Date.now() / 1000)
  const windowKey = `${key}:${Math.floor(now / 60)}`
  try {
    const [count] = await redis.pipeline().incr(windowKey).expire(windowKey, 120).exec<[number, number]>()
    return count > X402_RATE_LIMIT_PER_MINUTE ? { limited: true, retryAfterSeconds: 60 - (now % 60) } : { limited: false }
  } catch (err) {
    console.error('[x402] rate limit store unavailable — allowing request', err)
    return { limited: false }
  }
}

/** Per IP, counted before verification: caps junk headers from one source. */
export function consumeIpLimit(ip: string): Promise<RateLimitResult> {
  return consume(`x402:rl:ip:${ip}`)
}

/**
 * Per payer, counted only AFTER the facilitator has verified the payment, so
 * the address is one the caller proved control of. A forged X-PAYMENT naming
 * someone else's address fails verification and never touches their quota.
 */
export function consumePayerLimit(payer: string): Promise<RateLimitResult> {
  return consume(`x402:rl:payer:${payer.toLowerCase()}`)
}
