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
    gameId: 'NFL-TEST', // '' = not a v1.6 market
    code: '0x60',
    readFail: {},      // readContract functionName or 'getCode' -> throw a non-revert RPC error
    delayMs: {},       // 'multicall' | 'chunkSimulate' -> slow RPC
  }
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const rpcError = () => Object.assign(new Error('HTTP request failed: request timed out'), { name: 'TimeoutError' })

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

// lib/claim.ts reads only through lib/claim-rpc.ts; the constants mirror the real module.
mock.module(libUrl('claim-rpc'), {
  exports: {
    CLAIM_RPC_TIMEOUT_MS: 8_000,
    CLAIM_RPC_RETRY_COUNT: 1,
    CLAIM_RPC_WORST_CASE_MS: 16_150,
    claimPublicClient: {
      readContract: async ({ functionName }) => {
        if (world.readFail[functionName]) throw rpcError()
        if (functionName === 'gameIdByMarket') return world.gameId
        if (functionName === 'getBetsByAddress') return Array.from({ length: world.betCount }, (_, i) => BigInt(i))
        throw new Error(`unexpected readContract ${functionName}`)
      },
      multicall: async ({ contracts }) => {
        if (world.delayMs.multicall) await sleep(world.delayMs.multicall)
        return contracts.map(() => ({ bettor: BETTOR, claimed: false }))
      },
      getCode: async () => { if (world.readFail.getCode) throw rpcError(); return world.code },
      getBalance: async () => 10n ** 18n,
      simulateContract: async ({ args }) => {
        // per-bet checks pass one id; a chunk passes the whole batch
        if (args[1].length > 1 && world.delayMs.chunkSimulate) await sleep(world.delayMs.chunkSimulate)
        return { request: { ids: args[1] } }
      },
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

const { runClaim, CLAIM_CHUNK_SIZE, CLAIM_MAX_CHUNKS, CLAIM_CHUNK_BUDGET_MS } = await import(libUrl('claim'))
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

test('chunk budget covers two worst-case reads, a submit and the receipt wait', () => {
  assert.equal(CLAIM_CHUNK_BUDGET_MS, 2 * 16_150 + 5_000 + 15_000)
})

test('slow RPC before chunk 1 -> outOfTime with the claimable count, nothing sent, lock released', async () => {
  world.betCount = 30
  world.delayMs.multicall = 1_500 // the claimable-set read eats the last of the budget
  const out = await run(Date.now() + CLAIM_CHUNK_BUDGET_MS + 1_000)
  assert.deepEqual(out, { kind: 'outOfTime', remainingCount: 30 })
  assert.equal(world.sent.length, 0)
  assert.deepEqual(world.trace, ['acquire', 'release'])
})

test('slow RPC inside chunk 1 -> chunk 2 never starts, remainingCount reported, lock released', async () => {
  world.betCount = 60
  world.delayMs.chunkSimulate = 1_500
  const out = await run(Date.now() + CLAIM_CHUNK_BUDGET_MS + 1_000) // room for chunk 1 only
  assert.equal(out.kind, 'claimed')
  assert.equal(out.txHashes.length, 1)
  assert.equal(out.remainingCount, 35)
  assert.equal(out.incomplete, undefined)
  assert.deepEqual(world.trace, ['acquire', 'send:1', 'release'])
})

test('step 1: factory read fails -> 502 RpcError (not a 500), no lock taken', async () => {
  world.betCount = 5
  world.readFail.gameIdByMarket = true
  const out = await run()
  assert.equal(out.kind, 'error')
  assert.equal(out.status, 502)
  assert.equal(out.error, 'RpcError')
  assert.deepEqual(world.trace, [])
})

test('step 1: getCode fails on a non-v1.6 address -> 502 RpcError (not a 500)', async () => {
  world.gameId = ''
  world.readFail.getCode = true
  const out = await run()
  assert.equal(out.status, 502)
  assert.equal(out.error, 'RpcError')
  assert.deepEqual(world.trace, [])
})

test('step 1 still distinguishes no contract (404) from another factory (409)', async () => {
  world.gameId = ''
  world.code = '0x'
  assert.equal((await run()).status, 404)
  world.code = '0x60'
  const out = await run()
  assert.equal(out.status, 409)
  assert.equal(out.error, 'UnsupportedMarket')
})

test('no bets -> nothing, no lock taken', async () => {
  world.betCount = 0
  const out = await run()
  assert.equal(out.kind, 'nothing')
  assert.deepEqual(world.trace, [])
})
