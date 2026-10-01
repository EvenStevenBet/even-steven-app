// End-to-end test for POST /api/claim (and POST /api/claim/auto) against a
// Base mainnet fork. The route code runs unmodified in `next dev`; every RPC
// call it makes is redirected to the fork (rpc-redirect.mjs), the relay is a
// throwaway key funded only on the fork, and Redis is an in-memory mock.
// Nothing here can reach mainnet state: all writes go to the local fork.
//
// Usage:
//   cd <contracts repo>/scripts/fork-tests && FORK_BLOCK=<recent block> npx hardhat node
//   node scripts/claim-e2e/run.mjs          (from the web app root)

import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  createPublicClient, createTestClient, createWalletClient, http, parseAbi, parseEther, parseEventLogs,
  getAddress, maxUint256,
} from 'viem'
import { base } from 'viem/chains'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { startUpstashMock } from './upstash-mock.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const APP_ROOT = path.resolve(HERE, '../..')
const FORK = process.env.CLAIM_E2E_FORK_RPC ?? 'http://127.0.0.1:8545'
const APP_PORT = Number(process.env.CLAIM_E2E_APP_PORT ?? 13997)
const REDIS_PORT = Number(process.env.CLAIM_E2E_REDIS_PORT ?? 18079)
const APP = `http://127.0.0.1:${APP_PORT}`
const CRON_SECRET = 'claim-e2e-secret'

const FACTORY = '0x5906370b9831728ec523b647137a1bbf0ab45390'
const OWNER = '0x2e5Ff49699f0dA2E8A6a43f34BffC1c740E67916'
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const V110_MARKET = '0x05170a958B4a1F70Fd8c6495F650475bCcbE43e9' // Bills/Lions, Factory v1.5
const LIVENESS = 7200

const usdcAbi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
  'function masterMinter() view returns (address)',
  'function configureMinter(address,uint256) returns (bool)',
  'function mint(address,uint256) returns (bool)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
])
const factoryAbi = parseAbi([
  'function createMarket(string gameId, int256 oracleZ, uint256 protocolSeed) returns (address)',
  'function marketByGameId(string) view returns (address)',
])
const marketAbi = parseAbi([
  'function placeBet(bool greaterThan, uint256 stake)',
  'function closeBetting()',
  'function cancelMarket()',
  'function requestSettlement(int256 spread)',
  'function executeSettlement()',
  'struct Bet { address bettor; uint256 stake; bool greaterThan; int256 lockedZ; bool claimed; }',
  'function getBet(uint256) view returns (Bet)',
])

const POLL = { pollingInterval: 50 }
const pub = createPublicClient({ chain: base, transport: http(FORK, { timeout: 900000 }), ...POLL })
const test = createTestClient({ chain: base, mode: 'hardhat', transport: http(FORK, { timeout: 900000 }), ...POLL })
const walletFor = (account) => createWalletClient({ account, chain: base, transport: http(FORK, { timeout: 900000 }), ...POLL })

async function send(account, address, abi, functionName, args = []) {
  const hash = await walletFor(account).writeContract({ address, abi, functionName, args })
  const r = await pub.waitForTransactionReceipt({ hash })
  if (r.status !== 'success') throw new Error(`${functionName} reverted`)
  return r
}

let minterReady = false
async function mintUSDC(to, amount) {
  const master = await pub.readContract({ address: USDC, abi: usdcAbi, functionName: 'masterMinter' })
  await test.impersonateAccount({ address: master })
  await test.setBalance({ address: master, value: parseEther('10') })
  if (!minterReady) { await send(master, USDC, usdcAbi, 'configureMinter', [master, 2n ** 128n]); minterReady = true }
  await send(master, USDC, usdcAbi, 'mint', [to, amount])
}

const usdc = (a) => pub.readContract({ address: USDC, abi: usdcAbi, functionName: 'balanceOf', args: [a] })
const U = (n) => BigInt(Math.round(n * 1e6))

// ── reporting ────────────────────────────────────────────────────────────────
let failures = 0
function check(name, cond, detail = '') {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
  if (!cond) failures++
}
async function post(pathname, body, headers = {}) {
  const res = await fetch(`${APP}${pathname}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body),
  })
  let json = null
  try { json = await res.json() } catch {}
  return { status: res.status, json }
}

// ── fork fixtures ────────────────────────────────────────────────────────────
async function actor() {
  const a = privateKeyToAccount(generatePrivateKey())
  await test.setBalance({ address: a.address, value: parseEther('1') })
  return a
}

async function newMarket(gameId) {
  await mintUSDC(OWNER, U(10))
  await send(OWNER, USDC, usdcAbi, 'approve', [FACTORY, maxUint256])
  await send(OWNER, FACTORY, factoryAbi, 'createMarket', [gameId, 0n, U(1)])
  return pub.readContract({ address: FACTORY, abi: factoryAbi, functionName: 'marketByGameId', args: [gameId] })
}

async function bet(account, market, greaterThan, stake) {
  await mintUSDC(account.address, stake * 2n)
  await send(account, USDC, usdcAbi, 'approve', [market, maxUint256])
  await send(account, market, marketAbi, 'placeBet', [greaterThan, stake])
}

async function settle(market, spread) {
  await mintUSDC(OWNER, U(1000))
  await send(OWNER, USDC, usdcAbi, 'approve', [market, maxUint256])
  await send(OWNER, market, marketAbi, 'closeBetting')
  await send(OWNER, market, marketAbi, 'requestSettlement', [spread])
  await test.increaseTime({ seconds: LIVENESS + 100 })
  await test.mine({ blocks: 1 })
  await send(OWNER, market, marketAbi, 'executeSettlement')
}

// ── app ──────────────────────────────────────────────────────────────────────
function startApp(env) {
  const child = spawn('npx', ['next', 'dev', '-p', String(APP_PORT)], {
    cwd: APP_ROOT,
    env: {
      ...process.env,
      ...env,
      NODE_OPTIONS: `--import "${pathToFileURL(path.join(HERE, 'rpc-redirect.mjs')).href}"`,
      CLAIM_E2E_FORK_RPC: FORK,
      NEXT_PUBLIC_CHAIN: 'base',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const logs = []
  child.stdout.on('data', (d) => logs.push(String(d)))
  child.stderr.on('data', (d) => logs.push(String(d)))
  return { child, logs }
}

async function waitForApp() {
  for (let i = 0; i < 120; i++) {
    try { await fetch(`${APP}/api/claim`, { method: 'OPTIONS' }); return } catch {}
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error('next dev did not start')
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  const chainId = await pub.getChainId()
  if (chainId !== 8453) throw new Error(`fork at ${FORK} reports chain ${chainId}`)
  // A hardhat fork answers hardhat_metadata; real Base RPCs do not. Refuse to run otherwise.
  const meta = await fetch(FORK, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'hardhat_metadata', params: [] }) }).then((r) => r.json())
  if (!meta.result?.forkedNetwork) throw new Error(`${FORK} is not a hardhat fork — refusing to run`)
  console.log(`fork of Base at block ${meta.result.forkedNetwork.forkBlockNumber}`)

  await test.impersonateAccount({ address: OWNER })
  await test.setBalance({ address: OWNER, value: parseEther('10') })

  const relayKey = generatePrivateKey()
  const relay = privateKeyToAccount(relayKey)
  await test.setBalance({ address: relay.address, value: parseEther('1') })

  console.log('setting up markets on the fork…')
  const tag = Date.now().toString(36)
  const W = await actor(), L = await actor(), X = await actor(), Y = await actor(), N = await actor()
  const R = await actor()
  const M = await newMarket(`NFL-2099-01-01-HOME-ClaimHome${tag}-AWAY-ClaimAway`)
  await bet(W, M, true, U(10))
  await bet(W, M, true, U(5))
  await bet(L, M, false, U(20))
  await bet(X, M, true, U(3))
  await bet(X, M, false, U(4))
  await bet(Y, M, true, U(2))
  await settle(M, 14n) // home covers: greaterThan bets win
  const MC = await newMarket(`NFL-2099-01-02-HOME-RefundHome${tag}-AWAY-RefundAway`)
  await bet(R, MC, true, U(7))
  await send(OWNER, MC, marketAbi, 'cancelMarket')
  const MO = await newMarket(`NFL-2099-01-03-HOME-OpenHome${tag}-AWAY-OpenAway`)
  await bet(W, MO, true, U(1))
  console.log({ settled: M, canceled: MC, open: MO, relay: relay.address })

  const redis = await startUpstashMock(REDIS_PORT)
  const app = startApp({
    RELAY_PRIVATE_KEY: relayKey,
    SERVER_ALCHEMY_KEY: '',
    UPSTASH_REDIS_REST_URL: `http://127.0.0.1:${REDIS_PORT}`,
    UPSTASH_REDIS_REST_TOKEN: 'mock',
    RELAY_MIN_ETH: '0.002',
    CRON_SECRET,
    AUTO_CLAIM_ENABLED: 'true',
  })
  let crashed = false
  try {
    await waitForApp()
    await runTests({ M, MC, MO, W, L, X, Y, N, R, relay, redis })
  } catch (err) {
    crashed = true
    throw err
  } finally {
    app.child.kill('SIGTERM')
    redis.server.close()
    if (failures || crashed) console.log('\n--- next dev log (tail) ---\n' + app.logs.join('').split('\n').slice(-60).join('\n'))
  }
  console.log(`\n${failures ? `${failures} FAILED` : 'ALL PASSED'}`)
  process.exit(failures ? 1 : 0)
}

async function claimTxCount(relay) { return pub.getTransactionCount({ address: relay.address }) }

async function runTests(ctx) {
  const { M, MC, MO, W, L, X, Y, N, R, relay, redis } = ctx

  console.log('\nPOST /api/claim')

  // B1 winner claims all ids in one call; USDC lands at the bettor, not the relay
  {
    const before = await usdc(W.address), relayUsdcBefore = await usdc(relay.address), n0 = await claimTxCount(relay)
    const r = await post('/api/claim', { marketAddress: M, bettor: W.address })
    const after = await usdc(W.address)
    check('B1 winner: 200 success', r.status === 200 && r.json?.success === true, JSON.stringify(r.json))
    check('B1 winner: both bet ids in one call', JSON.stringify(r.json?.betIds) === JSON.stringify(['0', '1']), String(r.json?.betIds))
    check('B1 winner: relay is the throwaway fork relay', r.json?.relay === relay.address)
    check('B1 winner: exactly one relay tx', (await claimTxCount(relay)) === n0 + 1)
    check('B1 winner: bettor received `amount`', after - before === BigInt(r.json?.amount ?? -1), `${after - before} vs ${r.json?.amount}`)
    check('B1 winner: relay USDC unchanged', (await usdc(relay.address)) === relayUsdcBefore)
    if (r.json?.txHash) {
      const rc = await pub.getTransactionReceipt({ hash: r.json.txHash })
      const t = parseEventLogs({ abi: usdcAbi, eventName: 'Transfer', logs: rc.logs.filter((l) => getAddress(l.address) === getAddress(USDC)) })
      check('B1 winner: single USDC transfer market -> bettor', t.length === 1 && getAddress(t[0].args.from) === getAddress(M) && getAddress(t[0].args.to) === W.address)
      check('B1 winner: tx sent by the relay', getAddress(rc.from) === relay.address)
      check('B1 winner: integers are decimal strings', /^\d+$/.test(r.json.amount) && r.json.betIds.every((b) => typeof b === 'string'))
    }
  }

  // B2 losing bettor: nothing claimable, no tx
  {
    const n0 = await claimTxCount(relay)
    const r = await post('/api/claim', { marketAddress: M, bettor: L.address })
    check('B2 loser: 200 nothing claimable', r.status === 200 && r.json?.note === 'Nothing claimable' && r.json.claimed.length === 0, JSON.stringify(r.json))
    check('B2 loser: no tx', (await claimTxCount(relay)) === n0)
  }

  // B3 already-claimed bettor (W again, after the lock is cleared): nothing claimable, no tx
  {
    redis.flush()
    const n0 = await claimTxCount(relay)
    const r = await post('/api/claim', { marketAddress: M, bettor: W.address })
    check('B3 already claimed: nothing claimable', r.status === 200 && r.json?.note === 'Nothing claimable', JSON.stringify(r.json))
    check('B3 already claimed: no tx', (await claimTxCount(relay)) === n0)
  }

  // B4 v1.10 market: 409 UnsupportedMarket
  {
    const r = await post('/api/claim', { marketAddress: V110_MARKET, bettor: W.address })
    check('B4 v1.10 market: 409 UnsupportedMarket', r.status === 409 && r.json?.error === 'UnsupportedMarket', JSON.stringify(r.json))
  }

  // B5 mixed bettor: only the winning id is claimed; two identical concurrent requests send one tx
  {
    const n0 = await claimTxCount(relay)
    const [a, b] = await Promise.all([
      post('/api/claim', { marketAddress: M, bettor: X.address }),
      post('/api/claim', { marketAddress: M, bettor: X.address }),
    ])
    const ok = [a, b].filter((r) => r.json?.success)
    const other = [a, b].find((r) => !r.json?.success)
    check('B5 concurrent duplicate: exactly one success', ok.length === 1, `${a.status} ${b.status}`)
    check('B5 concurrent duplicate: other is locked or finds nothing',
      other && ((other.status === 409 && other.json?.error === 'ClaimInFlight') || other.json?.note === 'Nothing claimable'), JSON.stringify(other?.json))
    check('B5 concurrent duplicate: one tx', (await claimTxCount(relay)) === n0 + 1)
    check('B5 mixed bettor: only the winning id', JSON.stringify(ok[0]?.json?.betIds) === JSON.stringify(['3']), String(ok[0]?.json?.betIds))
    check('B5 lock held after submission', redis.keys().includes(`claim:${M.toLowerCase()}:${X.address.toLowerCase()}`))
  }

  // B6 relay below RELAY_MIN_ETH: refuse to submit, release the lock
  {
    await test.setBalance({ address: relay.address, value: parseEther('0.001') })
    const n0 = await claimTxCount(relay)
    const r = await post('/api/claim', { marketAddress: M, bettor: Y.address })
    check('B6 underfunded relay: 503 RelayUnderfunded', r.status === 503 && r.json?.error === 'RelayUnderfunded', JSON.stringify(r.json))
    check('B6 underfunded relay: no tx', (await claimTxCount(relay)) === n0)
    check('B6 underfunded relay: lock released', !redis.keys().some((k) => k.startsWith('claim:0x') && k.endsWith(Y.address.toLowerCase())))
    await test.setBalance({ address: relay.address, value: parseEther('1') })
  }

  // B7 no bets / open market: nothing claimable
  {
    const r1 = await post('/api/claim', { marketAddress: M, bettor: N.address })
    check('B7 no bets: nothing claimable', r1.json?.note === 'Nothing claimable', JSON.stringify(r1.json))
    const r2 = await post('/api/claim', { marketAddress: MO, bettor: W.address })
    check('B7 unsettled market: nothing claimable', r2.json?.note === 'Nothing claimable', JSON.stringify(r2.json))
  }

  // B8 validation
  {
    const r = await post('/api/claim', { marketAddress: 'nope', bettor: W.address })
    check('B8 bad address: 400 InvalidRequest', r.status === 400 && r.json?.field === 'marketAddress', JSON.stringify(r.json))
  }

  // B10 rate limit: 10 per minute per IP, then 429 (counted before validation)
  {
    redis.flush()
    const codes = []
    for (let i = 0; i < 11; i++) codes.push((await post('/api/claim', {})).status)
    check('B10 rate limit: 10 allowed, 11th is 429', codes.slice(0, 10).every((c) => c === 400) && codes[10] === 429, codes.join(','))
    redis.flush()
  }

  if (process.env.CLAIM_E2E_SKIP_AUTO !== '1') await runAutoTests(ctx)

  // B9 lock store down: fail closed
  {
    redis.server.close()
    await new Promise((r) => setTimeout(r, 200))
    const n0 = await claimTxCount(relay)
    const r = await post('/api/claim', { marketAddress: M, bettor: Y.address })
    check('B9 lock store down: 503 LockServiceUnavailable', r.status === 503 && r.json?.error === 'LockServiceUnavailable', JSON.stringify(r.json))
    check('B9 lock store down: no tx', (await claimTxCount(relay)) === n0)
  }
}

async function runAutoTests({ M, MC, Y, R, relay, redis }) {
  console.log('\nPOST /api/claim/auto')
  redis.flush()
  {
    const r = await post('/api/claim/auto', undefined)
    check('D1 no secret: 401', r.status === 401, JSON.stringify(r.json))
  }
  {
    const n0 = await claimTxCount(relay)
    const yBefore = await usdc(Y.address), rBefore = await usdc(R.address)
    const r = await post('/api/claim/auto', undefined, { authorization: `Bearer ${CRON_SECRET}` })
    const claims = r.json?.claims ?? []
    check('D2 cron: 200', r.status === 200, JSON.stringify(r.json))
    // Real settled v1.6 markets in the forked state may add claims of their own,
    // so require the fixture's two claims rather than an exact count.
    check('D2 cron: claims the remaining winner and the refund',
      claims.some((c) => c.bettor === Y.address && getAddress(c.marketAddress) === getAddress(M)) &&
      claims.some((c) => c.bettor === R.address && getAddress(c.marketAddress) === getAddress(MC)), JSON.stringify(claims))
    check('D2 cron: no errors', (r.json?.errors ?? []).length === 0, JSON.stringify(r.json?.errors))
    check('D2 cron: one tx per claim', (await claimTxCount(relay)) === n0 + claims.length, `${claims.length} claims`)
    check('D2 cron: winner paid', (await usdc(Y.address)) > yBefore)
    check('D2 cron: refund paid in full (7 USDC stake)', (await usdc(R.address)) - rBefore === U(7))
  }
  {
    redis.flush()
    const n0 = await claimTxCount(relay)
    const r = await post('/api/claim/auto', undefined, { authorization: `Bearer ${CRON_SECRET}` })
    check('D3 second run: nothing left, no tx', r.status === 200 && (r.json?.claims ?? []).length === 0 && (await claimTxCount(relay)) === n0, JSON.stringify(r.json))
  }
}

await main().catch((err) => { console.error(err); process.exit(1) })
