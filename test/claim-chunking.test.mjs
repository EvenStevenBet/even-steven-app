// Mocked test of runClaim() chunking in lib/claim.ts: no RPC, no relay key,
// no Redis. Run with: npm run test:claim
import { test, mock, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { encodeAbiParameters, encodeEventTopics, pad, parseAbi, toHex } from 'viem'

const MARKET = '0x00000000000000000000000000000000000000aa'
const BETTOR = '0x00000000000000000000000000000000000000bb'
const RELAY = '0x8a3eee4f6aD1c03Dc3d898ecD61283560Bd42fed'
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const PAYOUT = 2_000_000n // 2 USDC per winning bet

const events = parseAbi([
  'event PayoutClaimed(address indexed bettor, uint256 amount)',
  'event BetClaimed(address indexed bettor, uint256 indexed betId, uint256 payout)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
])
const log = (address, eventName, args, data) => ({
  address,
  topics: encodeEventTopics({ abi: events, eventName, args }),
  data,
  blockNumber: 1n, transactionHash: pad('0x01'), logIndex: 0, blockHash: pad('0x02'), transactionIndex: 0, removed: false,
})
const u256 = (v) => encodeAbiParameters([{ type: 'uint256' }], [v])

// ---- world: per-test chain + lock state the mocks read and record into ----
let world
beforeEach(() => {
  world = {
    betCount: 0,
    // chunk number (1-based) -> 'revert' | 'pending' | 'sendFail'
    failAt: {},
    sent: [],          // ids per submitted chunk
    receipts: new Map(),
    trace: [],         // acquire / send:N / refresh / release, in order
  }
})

function receiptFor(ids) {
  const total = PAYOUT * BigInt(ids.length)
  return {
    status: 'success',
    blockNumber: BigInt(world.sent.length),
    logs: [
      ...ids.map((id) => log(MARKET, 'BetClaimed', { bettor: BETTOR, betId: id }, u256(PAYOUT))),
      log(USDC, 'Transfer', { from: MARKET, to: BETTOR }, u256(total)),
      log(MARKET, 'PayoutClaimed', { bettor: BETTOR }, u256(total)),
    ],
  }
}

// runClaim logs every step; keep the test output to the results.
for (const level of ['log', 'warn', 'error']) mock.method(console, level, () => {})

const libUrl = (p) => new URL(`../lib/${p}.ts`, import.meta.url).href

mock.module(libUrl('server-client'), {
  exports: {
    serverPublicClient: {
      readContract: async ({ functionName }) => {
        if (functionName === 'gameIdByMarket') return 'NFL-TEST'
        if (functionName === 'getBetsByAddress') return Array.from({ length: world.betCount }, (_, i) => BigInt(i))
        throw new Error(`unexpected readContract ${functionName}`)
      },
      multicall: async ({ contracts }) => contracts.map(() => ({ bettor: BETTOR, claimed: false })),
      getCode: async () => '0x60',
      simulateContract: async ({ args }) => ({ request: { ids: args[1] } }),
      waitForTransactionReceipt: async ({ hash }) => {
        const r = world.receipts.get(hash)
        if (r === 'pending') throw new Error('timed out')
        return r
      },
    },
  },
})

mock.module(libUrl('relay'), {
  exports: {
    relayAccount: { address: RELAY },
    relayWalletClient: {
      writeContract: async ({ ids }) => {
        const n = world.sent.length + 1
        world.trace.push(`send:${n}`)
        if (world.failAt[n] === 'sendFail') throw new Error('connection reset')
        world.sent.push(ids)
        const hash = pad(toHex(n))
        const mode = world.failAt[n]
        world.receipts.set(hash, mode === 'pending' ? 'pending'
          : mode === 'revert' ? { status: 'reverted', blockNumber: BigInt(n), logs: [] }
          : receiptFor(ids))
        return hash
      },
    },
    getRelayEthBalance: async () => 10n ** 18n,
    RELAY_MIN_ETH: 1n,
  },
})

mock.module(libUrl('claim-abuse'), {
  exports: {
    acquireClaimLock: async () => { world.trace.push('acquire'); return true },
    refreshClaimLock: async () => { world.trace.push('refresh') },
    releaseClaimLock: async () => { world.trace.push('release') },
    CLAIM_LOCK_TTL_SECONDS: 60,
  },
})

const { runClaim, CLAIM_CHUNK_SIZE, CLAIM_MAX_CHUNKS } = await import(libUrl('claim'))
const run = (deadline = Date.now() + 3_600_000) => runClaim(MARKET, BETTOR, '[test]', deadline)
const sendsAndRefreshes = (n) => Array.from({ length: n }, (_, i) => (i === 0 ? ['send:1'] : ['refresh', `send:${i + 1}`])).flat()

test('constants are 25 bets x 8 chunks', () => {
  assert.equal(CLAIM_CHUNK_SIZE, 25)
  assert.equal(CLAIM_MAX_CHUNKS, 8)
})

test('26 bets -> 2 txs, remainingCount 0, lock refreshed between chunks and released at the end', async () => {
  world.betCount = 26
  const out = await run()
  assert.equal(out.kind, 'claimed')
  assert.equal(out.txHashes.length, 2)
  assert.deepEqual(world.sent.map((ids) => ids.length), [25, 1])
  assert.equal(out.betIds.length, 26)
  assert.equal(out.remainingCount, 0)
  assert.equal(out.amount, PAYOUT * 26n)
  assert.equal(out.txHash, out.txHashes[1])
  assert.equal(out.incomplete, undefined)
  assert.deepEqual(world.trace, ['acquire', ...sendsAndRefreshes(2), 'release'])
})

test('201 bets -> 8 txs, remainingCount 1', async () => {
  world.betCount = 201
  const out = await run()
  assert.equal(out.kind, 'claimed')
  assert.equal(out.txHashes.length, 8)
  assert.ok(world.sent.every((ids) => ids.length === 25))
  assert.equal(out.betIds.length, 200)
  assert.equal(out.remainingCount, 1)
  assert.deepEqual(world.trace, ['acquire', ...sendsAndRefreshes(8), 'release'])
})

test('chunk 2 mined-and-reverted -> chunk 1 kept, incomplete, lock released (nothing in flight)', async () => {
  world.betCount = 60
  world.failAt[2] = 'revert'
  const out = await run()
  assert.equal(out.kind, 'claimed')
  assert.equal(out.txHashes.length, 1)
  assert.equal(out.betIds.length, 25)
  assert.equal(out.remainingCount, 35)
  assert.equal(out.incomplete.error, 'SubmissionReverted')
  assert.ok(out.incomplete.details.txHash)
  assert.deepEqual(world.trace, ['acquire', 'send:1', 'refresh', 'send:2', 'release'])
})

test('chunk 2 pending -> chunk 1 kept, incomplete SubmissionPending, lock kept (tx may still land)', async () => {
  world.betCount = 60
  world.failAt[2] = 'pending'
  const out = await run()
  assert.equal(out.kind, 'claimed')
  assert.equal(out.txHashes.length, 1)
  assert.equal(out.remainingCount, 35)
  assert.equal(out.incomplete.error, 'SubmissionPending')
  assert.ok(out.incomplete.details.txHash)
  assert.deepEqual(world.trace, ['acquire', 'send:1', 'refresh', 'send:2'])
})

test('chunk 2 send fails -> chunk 1 kept, incomplete SubmissionFailed, lock kept (send may have reached the node)', async () => {
  world.betCount = 60
  world.failAt[2] = 'sendFail'
  const out = await run()
  assert.equal(out.kind, 'claimed')
  assert.equal(out.txHashes.length, 1)
  assert.equal(out.incomplete.error, 'SubmissionFailed')
  assert.deepEqual(world.trace, ['acquire', 'send:1', 'refresh', 'send:2'])
})

test('chunk 1 pending -> 504 SubmissionPending error, lock kept', async () => {
  world.betCount = 10
  world.failAt[1] = 'pending'
  const out = await run()
  assert.equal(out.kind, 'error')
  assert.equal(out.status, 504)
  assert.equal(out.error, 'SubmissionPending')
  assert.deepEqual(world.trace, ['acquire', 'send:1'])
})

test('time budget -> stops before a chunk it cannot finish, lock released', async () => {
  world.betCount = 60
  const out = await run(Date.now() + 1_000) // first chunk always runs; no room for a second
  assert.equal(out.kind, 'claimed')
  assert.equal(out.txHashes.length, 1)
  assert.equal(out.remainingCount, 35)
  assert.equal(out.incomplete, undefined)
  assert.deepEqual(world.trace, ['acquire', 'send:1', 'release'])
})

test('no bets -> nothing, no lock taken', async () => {
  world.betCount = 0
  const out = await run()
  assert.equal(out.kind, 'nothing')
  assert.deepEqual(world.trace, [])
})
