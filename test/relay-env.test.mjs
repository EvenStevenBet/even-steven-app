// lib/relay.ts at import: a missing RELAY_PRIVATE_KEY is fatal only in the Vercel Production
// environment. Preview deployments (NODE_ENV=production, VERCEL_ENV=preview) get a null relay, so
// POST /api/bet, /api/claim and /api/claim/auto answer their existing 503 RelayNotConfigured.
// Run with: npm run test:relay
import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'

const VARS = ['RELAY_PRIVATE_KEY', 'VERCEL_ENV', 'NODE_ENV', 'NEXT_PHASE', 'X402_RECEIVING_ADDRESS', 'NEXT_PUBLIC_ALCHEMY_KEY']
const saved = Object.fromEntries(VARS.map((k) => [k, process.env[k]]))
after(() => { for (const k of VARS) saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]) })
beforeEach(() => { for (const k of VARS) delete process.env[k] })

// lib/server-client.ts throws in production without this key, and every real deployment has it.
process.env.SERVER_ALCHEMY_KEY = 'test-server-key'

let n = 0
const loadRelay = (env) => {
  for (const [k, v] of Object.entries(env)) process.env[k] = v
  return import(`${new URL('../lib/relay.ts', import.meta.url).href}?case=${n++}`)
}

test('Vercel Production with no key: import throws, as before', async () => {
  await assert.rejects(loadRelay({ NODE_ENV: 'production', VERCEL_ENV: 'production' }), /RELAY_PRIVATE_KEY is not set/)
})

test('Vercel Preview with no key: imports, relay is null', async () => {
  const m = await loadRelay({ NODE_ENV: 'production', VERCEL_ENV: 'preview' })
  assert.equal(m.relayAccount, null)
  assert.equal(m.relayWalletClient, null)
})

test('the production build phase never throws', async () => {
  const m = await loadRelay({ NODE_ENV: 'production', VERCEL_ENV: 'production', NEXT_PHASE: 'phase-production-build' })
  assert.equal(m.relayAccount, null)
})

test('outside Vercel (local, CI) a missing key does not throw', async () => {
  const m = await loadRelay({ NODE_ENV: 'production' })
  assert.equal(m.relayAccount, null)
})

test('Production with a key: the relay account and wallet client are built', async () => {
  const key = generatePrivateKey()
  const m = await loadRelay({ NODE_ENV: 'production', VERCEL_ENV: 'production', RELAY_PRIVATE_KEY: key })
  assert.equal(m.relayAccount.address, privateKeyToAccount(key).address)
  assert.ok(m.relayWalletClient)
})

test('a key without the 0x prefix works, and Preview with a key works (a testnet-only preview relay)', async () => {
  const key = generatePrivateKey()
  const m = await loadRelay({ NODE_ENV: 'production', VERCEL_ENV: 'preview', RELAY_PRIVATE_KEY: key.slice(2) })
  assert.equal(m.relayAccount.address, privateKeyToAccount(key).address)
})

test('a relay key that is the x402 receiving address still throws in every environment', async () => {
  const key = generatePrivateKey()
  for (const vercelEnv of ['production', 'preview']) {
    await assert.rejects(
      loadRelay({ NODE_ENV: 'production', VERCEL_ENV: vercelEnv, RELAY_PRIVATE_KEY: key, X402_RECEIVING_ADDRESS: privateKeyToAccount(key).address }),
      /dedicated ETH-only wallet/,
    )
  }
})

test('every consumer of the relay answers 503 RelayNotConfigured when it is null', () => {
  for (const f of ['../app/api/bet/route.ts', '../lib/claim.ts']) {
    const src = readFileSync(new URL(f, import.meta.url), 'utf8')
    assert.match(src, /!relayAccount \|\| !relayWalletClient/, f)
    assert.match(src, /503, 'RelayNotConfigured'/, f)
  }
  const auto = readFileSync(new URL('../app/api/claim/auto/route.ts', import.meta.url), 'utf8')
  assert.match(auto, /skipped: 'RelayNotConfigured'/)
})
