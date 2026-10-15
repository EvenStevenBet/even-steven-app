// The real claim read client (lib/claim-rpc.ts) against an RPC that never
// answers: each call must give up after 8s and retry once, so a slow node
// costs at most ~16s per read. Run with: npm run test:claim
import { test, mock, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { base } from 'viem/chains'

let requests = 0
const open = new Set()
const server = createServer((req) => { requests++; open.add(req.socket) }) // never responds
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const url = `http://127.0.0.1:${server.address().port}`
after(() => { for (const s of open) s.destroy(); server.close() })

mock.module(new URL('../lib/server-client.ts', import.meta.url).href, {
  exports: { serverPublicClient: { chain: base, transport: { url } } },
})

const { claimPublicClient, CLAIM_RPC_TIMEOUT_MS, CLAIM_RPC_RETRY_COUNT, CLAIM_RPC_WORST_CASE_MS } =
  await import(new URL('../lib/claim-rpc.ts', import.meta.url).href)

test('claim read client: 8s timeout, 1 retry, same endpoint as the server client', () => {
  assert.equal(CLAIM_RPC_TIMEOUT_MS, 8_000)
  assert.equal(CLAIM_RPC_RETRY_COUNT, 1)
  assert.equal(CLAIM_RPC_WORST_CASE_MS, 16_150)
  assert.equal(claimPublicClient.transport.timeout, 8_000)
  assert.equal(claimPublicClient.transport.retryCount, 1)
  assert.equal(claimPublicClient.transport.url, url)
})

test('a hung RPC fails after two 8s attempts (~16s), not viem\'s default 4 x 10s', async () => {
  requests = 0
  const t0 = Date.now()
  await assert.rejects(claimPublicClient.getBlockNumber({ cacheTime: 0 }), (err) => /took too long|timed out/i.test(err.shortMessage ?? err.message))
  const elapsed = Date.now() - t0
  assert.equal(requests, 2, 'one try plus one retry')
  assert.ok(elapsed >= 15_500 && elapsed <= 18_500, `elapsed ${elapsed}ms`)
})
