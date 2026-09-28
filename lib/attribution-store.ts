import { Redis } from '@upstash/redis'
import type { Address, Hash } from 'viem'
import type { ResolvedRef } from '@/lib/refs'

// Server-side. One record per bet transaction, written once and never expired.
// Same Upstash instance as lib/abuse.ts, separate client so the relay's lock and
// strike code stays untouched. scripts/points.mjs and the ops builder report read
// attr:index (a sorted set of txHashes scored by block timestamp) and then attr:tx:*.

const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL
const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN
const redis = url && token ? new Redis({ url, token, retry: { retries: 1 } }) : null

export const ATTRIBUTION_RATE_LIMIT_PER_MINUTE = 20

export interface AttributionRecord {
  txHash: Hash
  marketAddress: Address
  betId: string
  bettor: Address
  stake: string
  fee: string
  ref: string | null
  refType: 'builder' | 'address' | null
  /** Builder payout address, or the referring address itself. */
  refAddress: Address | null
  source: 'relay' | 'web'
  /** Unix seconds of the block the bet landed in. */
  ts: number
}

function store(): Redis {
  if (!redis) throw new Error('Upstash Redis is not configured (KV_REST_API_URL / KV_REST_API_TOKEN)')
  return redis
}

const recordKey = (txHash: string) => `attr:tx:${txHash.toLowerCase()}`
const INDEX_KEY = 'attr:index'

export function buildRecord(
  bet: { txHash: Hash; marketAddress: Address; betId: bigint; bettor: Address; stake: bigint; fee: bigint },
  ref: ResolvedRef | null,
  source: AttributionRecord['source'],
  ts: bigint,
): AttributionRecord {
  return {
    txHash: bet.txHash,
    marketAddress: bet.marketAddress,
    betId: bet.betId.toString(),
    bettor: bet.bettor,
    stake: bet.stake.toString(),
    fee: bet.fee.toString(),
    ref: ref?.id ?? null,
    refType: ref?.type ?? null,
    refAddress: ref === null ? null : ref.type === 'builder' ? ref.payoutAddress : ref.id,
    source,
    ts: Number(ts),
  }
}

/** Writes only if no record exists for this txHash. True when this call wrote it. */
export async function recordAttribution(record: AttributionRecord): Promise<boolean> {
  const written = (await store().set(recordKey(record.txHash), record, { nx: true })) === 'OK'
  // Indexed even when the record already existed, so a failed index write heals on retry.
  await store().zadd(INDEX_KEY, { nx: true }, { score: record.ts, member: record.txHash.toLowerCase() })
  return written
}

export async function hasAttribution(txHash: string): Promise<boolean> {
  return (await store().exists(recordKey(txHash))) === 1
}

/** Fixed one-minute window per IP, separate from POST /api/bet's limit. */
export async function consumeAttributionRateLimit(ip: string): Promise<boolean> {
  const key = `attr:rl:ip:${ip}:${Math.floor(Date.now() / 60_000)}`
  const [count] = await store().pipeline().incr(key).expire(key, 120).exec<[number, number]>()
  return count > ATTRIBUTION_RATE_LIMIT_PER_MINUTE
}
