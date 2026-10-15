// Fork rehearsal of the relay code paths — FORK TEST, NOT MAINNET.
//
// Runs the unmodified POST /api/bet and POST /api/claim route code (in `next dev`,
// from REHEARSAL_APP_ROOT) against a local Hardhat fork of Base. Every RPC call the
// app makes is redirected to the fork (rpc-redirect.mjs), optionally through a proxy
// that drops the response to the first eth_sendRawTransaction (stages C and D). The
// relay and bettors are throwaway keys generated here; the owner is impersonated on
// the fork; Redis is the in-memory mock. Every write is preceded by assertFork().
//
//   terminal 1:  cd <even-steven>/scripts/fork-tests && FORK_BLOCK=<recent> npx hardhat node --hostname 127.0.0.1
//   terminal 2:  STAGES=A,B REHEARSAL_APP_ROOT=<app tree> node scripts/claim-e2e/rehearsal.mjs
//
// Stages: A winner claim (relay bet + direct bet, UMA settle, zero-ETH claim)
//         B cancelled-market refund (relay bet, cancel, zero-ETH claim)
//         C claim send whose response is dropped after it mined (claim-nonce-collision)
//         D bet send whose response is dropped after it mined (bet-nonce-collision)

import { spawn } from 'node:child_process'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  createPublicClient, createTestClient, createWalletClient, encodeAbiParameters, getAddress, http as httpT,
  keccak256, maxUint256, parseAbi, parseEther, parseEventLogs, toHex,
} from 'viem'
import { base } from 'viem/chains'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { randomBytes } from 'node:crypto'
import { startUpstashMock } from './upstash-mock-bet.mjs' // upstash-mock.mjs + MGET for the bet route

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FORK = process.env.REHEARSAL_FORK_RPC ?? 'http://127.0.0.1:8545'
const STAGES = (process.env.STAGES ?? 'A,B').split(',').map((s) => s.trim())
const APP_ROOT = path.resolve(process.env.REHEARSAL_APP_ROOT ?? path.resolve(HERE, '../..'))
const APP_PORT = Number(process.env.REHEARSAL_APP_PORT ?? 13997)
const REDIS_PORT = Number(process.env.REHEARSAL_REDIS_PORT ?? 18079)
const PROXY_PORT = Number(process.env.REHEARSAL_PROXY_PORT ?? 8546)
const APP = `http://127.0.0.1:${APP_PORT}`

const FACTORY = '0x5906370b9831728ec523b647137a1bbf0ab45390'
const OWNER = '0x2e5Ff49699f0dA2E8A6a43f34BffC1c740E67916'
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
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
  'function FEE_PERCENT() view returns (uint256)',
  'function totalPool() view returns (uint256)',
  'function protocolSeedTotal() view returns (uint256)',
  'function cachedWinningStakes() view returns (uint256)',
  'function refundMode() view returns (bool)',
  'struct Bet { address bettor; uint256 stake; bool greaterThan; int256 lockedZ; bool claimed; }',
  'function getBet(uint256) view returns (Bet)',
  'event SettlementDetails(uint256 distributable, uint256 winningStakes)',
  'event BetPlaced(address indexed bettor, uint256 indexed betId, uint256 stake, uint256 fee, bool greaterThan, int256 lockedZ)',
])

const POLL = { pollingInterval: 50 }
const pub = createPublicClient({ chain: base, transport: httpT(FORK, { timeout: 900000 }), ...POLL })
const test = createTestClient({ chain: base, mode: 'hardhat', transport: httpT(FORK, { timeout: 900000 }), ...POLL })
const walletFor = (account) => createWalletClient({ account, chain: base, transport: httpT(FORK, { timeout: 900000 }), ...POLL })

// ── fork guard: before EVERY write ────────────────────────────────────────────
async function assertFork(url = FORK) {
  const host = new URL(url).hostname
  if (host !== '127.0.0.1') throw new Error(`refusing to write: RPC host is ${host}, not 127.0.0.1`)
  const call = async (method) => (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: [] }) }).then((r) => r.json())).result
  const chainId = await call('eth_chainId')
  const meta = await call('hardhat_metadata')
  if (chainId !== '0x2105' || !meta?.forkedNetwork) throw new Error(`refusing to write: ${host} is not the local Base fork`)
}

// ── reporting ────────────────────────────────────────────────────────────────
let failures = 0
const results = []
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond, detail })
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}

// ── fork fixtures ────────────────────────────────────────────────────────────
async function send(account, address, abi, functionName, args = []) {
  await assertFork()
  const hash = await walletFor(account).writeContract({ address, abi, functionName, args })
  const r = await pub.waitForTransactionReceipt({ hash })
  if (r.status !== 'success') throw new Error(`${functionName} reverted`)
  return r
}
let minterReady = false
async function mintUSDC(to, amount) {
  await assertFork()
  const master = await pub.readContract({ address: USDC, abi: usdcAbi, functionName: 'masterMinter' })
  await test.impersonateAccount({ address: master })
  await test.setBalance({ address: master, value: parseEther('10') })
  if (!minterReady) { await send(master, USDC, usdcAbi, 'configureMinter', [master, 2n ** 128n]); minterReady = true }
  await send(master, USDC, usdcAbi, 'mint', [to, amount])
}
const usdc = (a) => pub.readContract({ address: USDC, abi: usdcAbi, functionName: 'balanceOf', args: [a] })
const eth = (a) => pub.getBalance({ address: a })
const U = (n) => BigInt(Math.round(n * 1e6))

async function actor({ ethBalance = parseEther('1') } = {}) {
  await assertFork()
  const a = privateKeyToAccount(generatePrivateKey())
  await test.setBalance({ address: a.address, value: ethBalance })
  return a
}
async function newMarket(gameId) {
  await mintUSDC(OWNER, U(10))
  await send(OWNER, USDC, usdcAbi, 'approve', [FACTORY, maxUint256])
  const r = await send(OWNER, FACTORY, factoryAbi, 'createMarket', [gameId, 0n, U(1)])
  const m = await pub.readContract({ address: FACTORY, abi: factoryAbi, functionName: 'marketByGameId', args: [gameId] })
  return { market: m, createTx: r.transactionHash }
}
async function directBet(account, market, greaterThan, stake) {
  await mintUSDC(account.address, stake * 2n)
  await send(account, USDC, usdcAbi, 'approve', [market, maxUint256])
  const r = await send(account, market, marketAbi, 'placeBet', [greaterThan, stake])
  return r.transactionHash
}
async function settle(market, spread) {
  await mintUSDC(OWNER, U(1000))
  await send(OWNER, USDC, usdcAbi, 'approve', [market, maxUint256])
  const close = await send(OWNER, market, marketAbi, 'closeBetting')
  const assert = await send(OWNER, market, marketAbi, 'requestSettlement', [spread])
  await assertFork(); await test.increaseTime({ seconds: LIVENESS + 100 }); await test.mine({ blocks: 1 })
  const exec = await send(OWNER, market, marketAbi, 'executeSettlement')
  const det = parseEventLogs({ abi: marketAbi, eventName: 'SettlementDetails', logs: exec.logs })[0]?.args
  return { closeTx: close.transactionHash, assertTx: assert.transactionHash, executeTx: exec.transactionHash, details: det }
}

// ── app + proxy ──────────────────────────────────────────────────────────────
// The proxy forwards everything to the fork. While `dropSends > 0`, it forwards an
// eth_sendRawTransaction, waits for the fork's answer (automine: the tx is mined), then
// destroys the socket without answering — a send that "timed out" after it landed.
let dropSends = 0
const dropped = []
function startProxy() {
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c)
    const body = Buffer.concat(chunks).toString()
    let isSend = false
    try { const j = JSON.parse(body); isSend = (Array.isArray(j) ? j : [j]).some((x) => x.method === 'eth_sendRawTransaction') } catch {}
    const upstream = await fetch(FORK, { method: 'POST', headers: { 'content-type': 'application/json' }, body })
    const text = await upstream.text()
    if (isSend && dropSends > 0) {
      dropSends--
      try { dropped.push(JSON.parse(text).result) } catch { dropped.push(null) }
      req.socket.destroy()
      return
    }
    res.writeHead(upstream.status, { 'content-type': 'application/json' }); res.end(text)
  })
  return new Promise((r) => server.listen(PROXY_PORT, '127.0.0.1', () => r(server)))
}

function startApp(rpcTarget, relayKey) {
  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
    NODE_ENV: 'development',
    NODE_OPTIONS: `--import "${pathToFileURL(path.join(HERE, 'rpc-redirect.mjs')).href}"`,
    CLAIM_E2E_FORK_RPC: rpcTarget,
    NEXT_PUBLIC_CHAIN: 'base',
    RELAY_PRIVATE_KEY: relayKey,           // throwaway, generated here
    SERVER_ALCHEMY_KEY: '',                 // dev fallback URL, redirected to the fork
    NEXT_PUBLIC_ALCHEMY_KEY: '',
    KV_REST_API_URL: `http://127.0.0.1:${REDIS_PORT}`, KV_REST_API_TOKEN: 'mock',
    UPSTASH_REDIS_REST_URL: `http://127.0.0.1:${REDIS_PORT}`, UPSTASH_REDIS_REST_TOKEN: 'mock',
    RELAY_MIN_ETH: '0.002',
    NEXT_TELEMETRY_DISABLED: '1',
  }
  const child = spawn(path.join(APP_ROOT, 'node_modules/.bin/next'), ['dev', '-p', String(APP_PORT)], { cwd: APP_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
  const logs = []
  child.stdout.on('data', (d) => logs.push(String(d)))
  child.stderr.on('data', (d) => logs.push(String(d)))
  return { child, logs }
}
async function waitForApp() {
  for (let i = 0; i < 180; i++) {
    try { await fetch(`${APP}/api/claim`, { method: 'OPTIONS' }); return } catch {}
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error('next dev did not start')
}
async function post(pathname, body) {
  const res = await fetch(`${APP}${pathname}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  let json = null; try { json = await res.json() } catch {}
  return { status: res.status, json }
}

// A relayed bet: the bettor signs an EIP-3009 ReceiveWithAuthorization; POST /api/bet submits it.
async function relayBet(bettor, market, greaterThan, stake, rpcTarget) {
  await mintUSDC(bettor.address, stake * 2n)
  const feeBps = await pub.readContract({ address: market, abi: marketAbi, functionName: 'FEE_PERCENT' })
  const value = stake + (stake * feeBps) / 10_000n
  const salt = toHex(randomBytes(32))
  const nonce = keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'bool' }], [salt, greaterThan]))
  const forkNow = Number((await pub.getBlock()).timestamp)
  const validBefore = BigInt(Math.max(forkNow, Math.floor(Date.now() / 1000)) + 3600)
  const signature = await bettor.signTypedData({
    domain: { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: USDC },
    types: { ReceiveWithAuthorization: [
      { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' }] },
    primaryType: 'ReceiveWithAuthorization',
    message: { from: bettor.address, to: market, value, validAfter: 0n, validBefore, nonce },
  })
  await assertFork(); await assertFork(rpcTarget) // the app writes through rpcTarget
  return post('/api/bet', {
    marketAddress: market, bettor: bettor.address, greaterThan, stake: stake.toString(),
    validAfter: '0', validBefore: validBefore.toString(), nonce, salt, signature,
  })
}
async function relayClaim(market, bettor, rpcTarget) {
  await assertFork(); await assertFork(rpcTarget)
  return post('/api/claim', { marketAddress: market, bettor: bettor.address })
}

// Receipt checks shared by A and B: market -> bettor USDC equals the payout, relay untouched.
async function receiptChecks(label, txHash, { market, bettor, relay, payout }) {
  const rc = await pub.getTransactionReceipt({ hash: txHash })
  const transfers = parseEventLogs({ abi: usdcAbi, eventName: 'Transfer', logs: rc.logs.filter((l) => getAddress(l.address) === getAddress(USDC)) })
  check(`${label}: tx sent by the relay`, getAddress(rc.from) === relay.address, rc.from)
  check(`${label}: exactly one USDC transfer, market -> bettor, = payout`, transfers.length === 1 &&
    getAddress(transfers[0].args.from) === getAddress(market) && getAddress(transfers[0].args.to) === bettor.address &&
    transfers[0].args.value === payout, transfers.map((t) => `${t.args.from}->${t.args.to} ${t.args.value}`).join(', '))
  check(`${label}: no USDC to or from the relay`, !transfers.some((t) => getAddress(t.args.from) === relay.address || getAddress(t.args.to) === relay.address))
}

// ── stages ───────────────────────────────────────────────────────────────────
async function stageA(relay) {
  console.log('\n== Stage A: winner claim (relay bet + direct bet, UMA settle, zero-ETH claim)')
  const tag = Date.now().toString(36)
  const { market: M, createTx } = await newMarket(`NFL-2099-02-01-HOME-RehearseHome${tag}-AWAY-RehearseAway`)
  const W = await actor({ ethBalance: 0n })            // winner: zero ETH throughout
  const L = await actor()                              // loser: bets directly
  const wEth0 = await eth(W.address)
  const relayUsdc0 = await usdc(relay.address)
  const rb = await relayBet(W, M, true, U(10), FORK)
  check('A relay bet (placeBetFor via POST /api/bet): 200', rb.status === 200 && rb.json?.success, JSON.stringify(rb.json))
  const betRc = rb.json?.txHash ? await pub.getTransactionReceipt({ hash: rb.json.txHash }) : null
  check('A relay bet: sent by the relay, bettor recorded as W', betRc && getAddress(betRc.from) === relay.address && rb.json?.bettor === W.address)
  const directTx = await directBet(L, M, false, U(6))
  const st = await settle(M, 14n) // home by 14: greaterThan wins
  const [totalPool, seedTotal, winning] = await Promise.all(['totalPool', 'protocolSeedTotal', 'cachedWinningStakes']
    .map((f) => pub.readContract({ address: M, abi: marketAbi, functionName: f })))
  const distributable = totalPool - seedTotal
  const expected = (U(10) * distributable) / winning
  check('A SettlementDetails matches pool reads', st.details?.distributable === distributable && st.details?.winningStakes === winning,
    `distributable ${distributable}, winningStakes ${winning}`)
  const before = await usdc(W.address)
  const cl = await relayClaim(M, W, FORK)
  const after = await usdc(W.address)
  check('A claim via POST /api/claim: 200', cl.status === 200 && cl.json?.success, JSON.stringify(cl.json))
  check('A payout = stake x distributable / winningStakes', after - before === expected && BigInt(cl.json?.amount ?? -1) === expected,
    `got ${after - before}, expected ${U(10)} x ${distributable} / ${winning} = ${expected}`)
  if (cl.json?.txHash) await receiptChecks('A claim', cl.json.txHash, { market: M, bettor: W, relay, payout: expected })
  if (rb.json?.txHash) {
    const t = parseEventLogs({ abi: usdcAbi, eventName: 'Transfer', logs: betRc.logs.filter((l) => getAddress(l.address) === getAddress(USDC)) })
    check('A relay bet: no USDC to or from the relay', !t.some((x) => getAddress(x.args.from) === relay.address || getAddress(x.args.to) === relay.address))
  }
  check('A relay USDC balance unchanged', (await usdc(relay.address)) === relayUsdc0)
  check('A winner ETH unchanged (zero throughout)', (await eth(W.address)) === wEth0 && wEth0 === 0n, `${wEth0} -> ${await eth(W.address)}`)
  return { market: M, createTx, relayBetTx: rb.json?.txHash, directBetTx: directTx, ...st, claimTx: cl.json?.txHash, payout: expected, distributable, winning }
}

async function stageB(relay) {
  console.log('\n== Stage B: cancelled-market refund (relay bet, cancel, zero-ETH claim)')
  const tag = Date.now().toString(36)
  const { market: M, createTx } = await newMarket(`NFL-2099-02-02-HOME-RefundHome${tag}-AWAY-RefundAway`)
  const R = await actor({ ethBalance: 0n })
  const rEth0 = await eth(R.address)
  const rb = await relayBet(R, M, true, U(5), FORK)
  check('B relay bet: 200', rb.status === 200 && rb.json?.success, JSON.stringify(rb.json))
  const cancel = await send(OWNER, M, marketAbi, 'cancelMarket')
  check('B market in refund mode', await pub.readContract({ address: M, abi: marketAbi, functionName: 'refundMode' }))
  const before = await usdc(R.address)
  const cl = await relayClaim(M, R, FORK)
  const after = await usdc(R.address)
  check('B claim via POST /api/claim: 200', cl.status === 200 && cl.json?.success, JSON.stringify(cl.json))
  check('B refund = stake (fee not refunded)', after - before === U(5), `${after - before}`)
  if (cl.json?.txHash) await receiptChecks('B claim', cl.json.txHash, { market: M, bettor: R, relay, payout: U(5) })
  check('B bettor ETH unchanged (zero throughout)', (await eth(R.address)) === rEth0 && rEth0 === 0n)
  return { market: M, createTx, relayBetTx: rb.json?.txHash, cancelTx: cancel.transactionHash, claimTx: cl.json?.txHash }
}

async function stageC(relay, proxyUrl) {
  console.log('\n== Stage C: claim send dropped after it mined (claim-nonce-collision)')
  const tag = Date.now().toString(36)
  const { market: M } = await newMarket(`NFL-2099-02-03-HOME-DropHome${tag}-AWAY-DropAway`)
  const W = await actor({ ethBalance: 0n }), L = await actor()
  await directBet(await actor(), M, false, U(3)) // a loser so the winner is paid from a real pool
  await directBet(L, M, false, U(1))
  // winner bets directly with ETH borrowed only for the bet, then set back to zero
  await test.setBalance({ address: W.address, value: parseEther('1') })
  await directBet(W, M, true, U(4))
  await test.setBalance({ address: W.address, value: 0n })
  await settle(M, 14n)
  const n0 = await pub.getTransactionCount({ address: relay.address })
  dropSends = 1; dropped.length = 0
  const cl = await relayClaim(M, W, proxyUrl)
  const n1 = await pub.getTransactionCount({ address: relay.address })
  check('C first send was dropped by the proxy after the fork accepted it', dropped.length === 1 && !!dropped[0], String(dropped[0]))
  check('C claim still answers 200 success', cl.status === 200 && cl.json?.success, JSON.stringify(cl.json))
  check('C returned hash = the dropped (first) transaction', cl.json?.txHash === dropped[0], `${cl.json?.txHash} vs ${dropped[0]}`)
  check('C relay sent exactly one transaction (no re-sign)', n1 - n0 === 1, `${n1 - n0}`)
  return { market: M, droppedTx: dropped[0], returnedTx: cl.json?.txHash }
}

async function stageD(relay, proxyUrl, redis) {
  console.log('\n== Stage D: bet send dropped after it mined (bet-nonce-collision)')
  const tag = Date.now().toString(36)
  const { market: M } = await newMarket(`NFL-2099-02-04-HOME-BetDropHome${tag}-AWAY-BetDropAway`)
  const B = await actor({ ethBalance: 0n })
  const n0 = await pub.getTransactionCount({ address: relay.address })
  dropSends = 1; dropped.length = 0
  const rb = await relayBet(B, M, true, U(2), proxyUrl)
  const n1 = await pub.getTransactionCount({ address: relay.address })
  const bet0 = await pub.readContract({ address: M, abi: marketAbi, functionName: 'getBet', args: [0n] }).catch(() => null)
  check('D first send was dropped by the proxy after the fork accepted it', dropped.length === 1 && !!dropped[0], String(dropped[0]))
  check('D bet still answers 200 success', rb.status === 200 && rb.json?.success, JSON.stringify(rb.json))
  check('D returned hash = the dropped (first) transaction', rb.json?.txHash === dropped[0], `${rb.json?.txHash} vs ${dropped[0]}`)
  check('D relay sent exactly one transaction (no re-sign)', n1 - n0 === 1, `${n1 - n0}`)
  check('D bet 0 recorded for the bettor', bet0 && getAddress(bet0.bettor) === B.address)
  check('D no strike recorded', !redis.keys().some((k) => k.startsWith('bet:strikes')), redis.keys().filter((k) => k.includes('strike')).join(','))
  return { market: M, droppedTx: dropped[0], returnedTx: rb.json?.txHash }
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  await assertFork()
  const meta = (await fetch(FORK, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'hardhat_metadata', params: [] }) }).then((r) => r.json())).result
  console.log(`FORK TEST, NOT MAINNET — Base fork at block ${meta.forkedNetwork.forkBlockNumber}, app ${path.basename(APP_ROOT)}, stages ${STAGES.join(',')}`)
  await test.impersonateAccount({ address: OWNER })
  await test.setBalance({ address: OWNER, value: parseEther('10') })
  const relayKey = generatePrivateKey()
  const relay = privateKeyToAccount(relayKey)
  await test.setBalance({ address: relay.address, value: parseEther('1') })

  const needProxy = STAGES.includes('C') || STAGES.includes('D')
  const proxy = needProxy ? await startProxy() : null
  const rpcTarget = needProxy ? `http://127.0.0.1:${PROXY_PORT}` : FORK
  if (needProxy) await assertFork(rpcTarget)
  const redis = await startUpstashMock(REDIS_PORT)
  const app = startApp(rpcTarget, relayKey)
  const out = {}
  try {
    await waitForApp()
    if (STAGES.includes('A')) out.A = await stageA(relay)
    if (STAGES.includes('B')) out.B = await stageB(relay)
    if (STAGES.includes('C')) out.C = await stageC(relay, rpcTarget)
    if (STAGES.includes('D')) out.D = await stageD(relay, rpcTarget, redis)
  } catch (err) {
    failures++
    console.log('STAGE ERROR:', err?.shortMessage ?? err?.message ?? err)
  } finally {
    app.child.kill('SIGTERM')
    redis.server.close()
    proxy?.close()
  }
  const bigint = (k, v) => (typeof v === 'bigint' ? v.toString() : v)
  console.log('\nRESULT ' + JSON.stringify({ relay: relay.address, failures, out }, bigint))
  if (failures) console.log('\n--- next dev log (tail, redacted) ---\n' + app.logs.join('').replace(/\/v2\/[A-Za-z0-9_-]+/g, '/v2/***').split('\n').slice(-40).join('\n'))
  process.exit(failures ? 1 : 0)
}
await main()
