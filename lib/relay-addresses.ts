import { getAddress, isAddress } from 'viem'

// The relay wallet's public address, kept as data in data/relay.json so rotating the relay key never
// needs a code change. Public addresses only: the key itself is the Vercel variable RELAY_PRIVATE_KEY.
//
//   current   the relay that is live now. Monitors and scripts read this.
//   previous  relays retired earlier, kept so old transactions still label as relayed.
//   next      the replacement, set BEFORE the key swap so both addresses are accepted during the switch.
//
// Rotation, as data only: set next, swap the key, then set current to the new address, move the old
// one into previous and clear next.

export interface RelayConfig {
  current: string
  previous: string[]
  next: string | null
}

/** Throws on a malformed file. Returns checksummed addresses. */
export function parseRelayConfig(raw: unknown): { current: string; previous: string[]; next: string | null } {
  const c = raw as Partial<RelayConfig> | null
  if (!c || typeof c !== 'object') throw new Error('relay config must be an object')
  const addr = (v: unknown, name: string): string => {
    if (typeof v !== 'string' || !isAddress(v, { strict: false })) throw new Error(`relay config: ${name} is not an address`)
    return getAddress(v)
  }
  const current = addr(c.current, 'current')
  if (!Array.isArray(c.previous)) throw new Error('relay config: previous must be an array')
  const previous = c.previous.map((v, i) => addr(v, `previous[${i}]`))
  const next = c.next === null || c.next === undefined ? null : addr(c.next, 'next')
  const all = [current, ...previous, ...(next ? [next] : [])]
  if (new Set(all.map((a) => a.toLowerCase())).size !== all.length) throw new Error('relay config: an address is listed twice')
  return { current, previous, next }
}

/** Every address a relayed transaction may legitimately come from, lowercased. */
export function relaySenders(raw: unknown): Set<string> {
  const c = parseRelayConfig(raw)
  return new Set([c.current, ...c.previous, ...(c.next ? [c.next] : [])].map((a) => a.toLowerCase()))
}

export function isRelaySender(from: string, raw: unknown): boolean {
  return relaySenders(raw).has(from.toLowerCase())
}
