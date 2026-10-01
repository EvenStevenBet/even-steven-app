import { Redis } from '@upstash/redis'

// Server-side only. Rate limits for the x402-priced GET routes, backed by the
// same Upstash Redis as lib/abuse.ts under x402:* keys. Since a 4xx answer is
// never settled (lib/x402-server.ts withPayment), a replayed or junk X-PAYMENT
// would otherwise cost us a facilitator /verify and the handler's RPC reads
// for free. Counted before either runs.
//
// Two fixed one-minute windows: per IP, and per payer address decoded from
// X-PAYMENT, so one signature replayed from many IPs is still capped.
//
// Fails OPEN: these routes only read and never move funds (the facilitator
// verifies every payment), so a Redis outage should not take paid data down.

export { clientIp } from '@/lib/abuse'

const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL
const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN
const redis = url && token ? new Redis({ url, token, retry: { retries: 1 } }) : null

const configured = Number(process.env.X402_RATE_LIMIT_PER_MINUTE)
export const X402_RATE_LIMIT_PER_MINUTE = Number.isInteger(configured) && configured > 0 ? configured : 30

export type RateLimitResult = { limited: false } | { limited: true; scope: 'ip' | 'payer'; retryAfterSeconds: number }

export async function consumeX402RateLimit(ip: string, payer: string | null): Promise<RateLimitResult> {
  if (!redis) {
    console.error('[x402] rate limit store not configured — allowing request')
    return { limited: false }
  }
  const now = Math.floor(Date.now() / 1000)
  const window = Math.floor(now / 60)
  const ipKey = `x402:rl:ip:${ip}:${window}`
  const payerKey = payer ? `x402:rl:payer:${payer.toLowerCase()}:${window}` : null
  try {
    const p = redis.pipeline().incr(ipKey).expire(ipKey, 120)
    if (payerKey) p.incr(payerKey).expire(payerKey, 120)
    const res = await p.exec<number[]>()
    const retryAfterSeconds = 60 - (now % 60)
    if (res[0] > X402_RATE_LIMIT_PER_MINUTE) return { limited: true, scope: 'ip', retryAfterSeconds }
    if (payerKey && res[2] > X402_RATE_LIMIT_PER_MINUTE) return { limited: true, scope: 'payer', retryAfterSeconds }
    return { limited: false }
  } catch (err) {
    console.error('[x402] rate limit store unavailable — allowing request', err)
    return { limited: false }
  }
}
