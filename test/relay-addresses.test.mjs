// data/relay.json and the relay-sender check used by POST /api/attribution. Run with: npm run test:relay
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const { parseRelayConfig, relaySenders, isRelaySender } =
  await import(new URL('../lib/relay-addresses.ts', import.meta.url).href)

const OLD = '0x8a3eee4f6aD1c03Dc3d898ecD61283560Bd42fed'
const NEW = '0x4444444444444444444444444444444444444444'
const OLDER = '0x5555555555555555555555555555555555555555'
const STRANGER = '0x6666666666666666666666666666666666666666'
const OWNER = '0x2e5Ff49699f0dA2E8A6a43f34BffC1c740E67916'
const V15_WALLET = '0x6cF0A0b5282409E24dC35e2c1834f9111315603B'

test('before the swap: only the current relay counts', () => {
  const cfg = { current: OLD, previous: [], next: null }
  assert.equal(isRelaySender(OLD, cfg), true)
  assert.equal(isRelaySender(NEW, cfg), false)
})

test('during the switch: current and next are both accepted', () => {
  const cfg = { current: OLD, previous: [], next: NEW }
  assert.equal(isRelaySender(OLD, cfg), true)
  assert.equal(isRelaySender(NEW, cfg), true)
  assert.equal(isRelaySender(STRANGER, cfg), false)
})

test('after the swap: the old relay stays accepted as previous, so old transactions still label as relayed', () => {
  const cfg = { current: NEW, previous: [OLD], next: null }
  assert.equal(isRelaySender(NEW, cfg), true)
  assert.equal(isRelaySender(OLD, cfg), true)
  assert.equal(isRelaySender(OLDER, cfg), false)
})

test('comparison ignores address case', () => {
  const cfg = { current: OLD, previous: [], next: null }
  assert.equal(isRelaySender(OLD.toLowerCase(), cfg), true)
  assert.equal(isRelaySender(OLD.toUpperCase().replace('0X', '0x'), cfg), true)
  assert.deepEqual([...relaySenders(cfg)], [OLD.toLowerCase()])
})

test('malformed or ambiguous configs are rejected, never half-read', () => {
  for (const bad of [null, 'x', {}, { current: 'nope', previous: [], next: null },
    { current: OLD, previous: 'x', next: null }, { current: OLD, previous: ['bad'], next: null },
    { current: OLD, previous: [], next: 'bad' }, { current: OLD, previous: [OLD], next: null },
    { current: OLD, previous: [], next: OLD }]) {
    assert.throws(() => parseRelayConfig(bad), undefined, JSON.stringify(bad))
  }
})

test('a missing next is fine', () => {
  assert.equal(parseRelayConfig({ current: OLD, previous: [] }).next, null)
})

test('the committed data/relay.json is valid and never lists an owner or x402 address', () => {
  const cfg = JSON.parse(readFileSync(new URL('../data/relay.json', import.meta.url), 'utf8'))
  const parsed = parseRelayConfig(cfg)
  assert.equal(parsed.current, OLD)
  const listed = [...relaySenders(cfg)]
  for (const forbidden of [OWNER, V15_WALLET]) assert.ok(!listed.includes(forbidden.toLowerCase()), forbidden)
})

test('POST /api/attribution labels the sender through the shared check, with no hard-coded relay', () => {
  const src = readFileSync(new URL('../app/api/attribution/route.ts', import.meta.url), 'utf8')
  assert.match(src, /isRelaySender\(tx\.from, relayConfig\)/)
  assert.doesNotMatch(src, /0x8a3eee/i)
})
