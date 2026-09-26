import { Redis } from '@upstash/redis'
import type { NextRequest } from 'next/server'

// Server-side only. Abuse protection for POST /api/bet, backed by Upstash Redis.
// Callers must treat any thrown error as "store unavailable" and fail closed:
// the relay never submits without holding the in-flight lock.

// The Vercel Marketplace Upstash integration injects KV_REST_API_*; a direct
// Upstash setup uses UPSTASH_REDIS_REST_*.
const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL
const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN
const redis = url && token ? new Redis({ url, token, retry: { retries: 1 } }) : null

export const LOCK_TTL_SECONDS = 300
export const STRIKE_TTL_SECONDS = 86_400
export const RATE_LIMIT_PER_MINUTE = 10

const configuredStrikes = Number(process.env.RELAY_MAX_STRIKES)
export const MAX_STRIKES = Number.isInteger(configuredStrikes) && configuredStrikes > 0 ? configuredStrikes : 3

function store(): Redis {
  if (!redis) throw new Error('Upstash Redis is not configured (KV_REST_API_URL / KV_REST_API_TOKEN)')
  return redis
}

// On Vercel both headers are set by the platform from the connecting client.
export function clientIp(request: NextRequest): string {
  return (
    request.headers.get('x-real-ip') ??
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    'unknown'
  )
}

const lockKey = (bettor: string, nonce: string) => `bet:lock:${bettor.toLowerCase()}:${nonce.toLowerCase()}`
const bettorStrikeKey = (bettor: string) => `bet:strikes:${bettor.toLowerCase()}`
const ipStrikeKey = (ip: string) => `bet:strikes:ip:${ip}`

/** Fixed one-minute window per IP. Counts every request, valid or not. */
export async function consumeRateLimit(ip: string): Promise<{ limited: boolean; retryAfterSeconds: number }> {
  const now = Math.floor(Date.now() / 1000)
  const key = `bet:rl:ip:${ip}:${Math.floor(now / 60)}`
  const [count] = await store().pipeline().incr(key).expire(key, 120).exec<[number, number]>()
  return { limited: count > RATE_LIMIT_PER_MINUTE, retryAfterSeconds: 60 - (now % 60) }
}

export async function strikeCounts(bettor: string, ip: string): Promise<{ bettor: number; ip: number }> {
  const [b, i] = await store().mget<(number | null)[]>(bettorStrikeKey(bettor), ipStrikeKey(ip))
  return { bettor: Number(b ?? 0), ip: Number(i ?? 0) }
}

/** SET NX: true only for the first caller holding this bettor + nonce. */
export async function acquireLock(bettor: string, nonce: string): Promise<boolean> {
  const res = await store().set(lockKey(bettor, nonce), Date.now(), { nx: true, ex: LOCK_TTL_SECONDS })
  return res === 'OK'
}

/** Only for failures before submission. A failed release just leaves the lock to expire. */
export async function releaseLock(bettor: string, nonce: string): Promise<void> {
  try {
    await store().del(lockKey(bettor, nonce))
  } catch (err) {
    console.error('[api/bet] lock release failed; it will expire on its own', err)
  }
}

export async function recordStrike(bettor: string, ip: string): Promise<void> {
  const b = bettorStrikeKey(bettor)
  const i = ipStrikeKey(ip)
  try {
    await store().pipeline()
      .incr(b).expire(b, STRIKE_TTL_SECONDS)
      .incr(i).expire(i, STRIKE_TTL_SECONDS)
      .exec()
  } catch (err) {
    console.error('[api/bet] failed to record revert strike', { bettor, ip }, err)
  }
}
