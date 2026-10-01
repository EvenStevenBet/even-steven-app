// Settle-on-2xx test for the three x402-priced routes. Runs the unmodified
// routes in `next dev` against a mock facilitator that counts /verify and
// /settle calls, so nothing is ever charged. Chain reads are real (mainnet,
// read-only) through the app's usual server RPC.
//
// Usage (from the web app root): node scripts/x402-settle-e2e/run.mjs

import http from 'node:http'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { generatePrivateKey } from 'viem/accounts'
import { createSigner } from 'x402/types'
import { createPaymentHeader } from 'x402/client'
import { startUpstashMock } from './upstash-mock.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const APP_ROOT = path.resolve(HERE, '../..')
const APP_PORT = Number(process.env.SETTLE_E2E_APP_PORT ?? 13998)
const FAC_PORT = Number(process.env.SETTLE_E2E_FAC_PORT ?? 18080)
const APP = `http://127.0.0.1:${APP_PORT}`
const REDIS_PORT = Number(process.env.SETTLE_E2E_REDIS_PORT ?? 18081)
const LIMIT = 5
let redis

const CLOSED_GAME = 'NFL-2026-09-28-HOME-Bears-AWAY-Eagles'
const SETTLED_MARKET = '0xF0F11bbce394Cf780a20f8A7F63490F50a175A26' // Dolphins/Chiefs
const BETTOR = '0x1164a458a716289c3d724fd1b3A8F5072593271e'

// ── mock facilitator ─────────────────────────────────────────────────────────
const calls = { verify: 0, settle: 0 }
let mode = 'ok' // ok | settle-fail | settle-error | verify-invalid
const TX = '0x' + 'ab'.repeat(32)
const fac = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    const json = (status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)) }
    const payer = JSON.parse(body || '{}').paymentPayload?.payload?.authorization?.from
    if (req.url.endsWith('/verify')) {
      calls.verify++
      return mode === 'verify-invalid'
        ? json(200, { isValid: false, invalidReason: 'invalid_exact_evm_payload_signature', payer })
        : json(200, { isValid: true, payer })
    }
    if (req.url.endsWith('/settle')) {
      calls.settle++
      if (mode === 'settle-error') return json(500, { error: 'boom' })
      if (mode === 'settle-fail') return json(200, { success: false, errorReason: 'insufficient_funds', transaction: '', network: 'base', payer })
      return json(200, { success: true, transaction: TX, network: 'base', payer })
    }
    json(404, {})
  })
})

// ── helpers ──────────────────────────────────────────────────────────────────
let failures = 0
function check(name, cond, detail = '') {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
  if (!cond) failures++
}
let header
// Every call clears the rate-limit store unless { keep: true }, so only the
// rate-limit section below is ever limited.
async function paid(pathname, { ip = '203.0.113.1', keep = false, payment = header } = {}) {
  if (!keep) redis?.flush()
  const before = { ...calls }
  const res = await fetch(`${APP}${pathname}`, { headers: { 'x-real-ip': ip, ...(payment ? { 'X-PAYMENT': payment } : {}) } })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch {}
  return {
    status: res.status, json, text,
    verified: calls.verify - before.verify, settled: calls.settle - before.settle,
    paymentResponse: res.headers.get('x-payment-response'),
    retryAfter: res.headers.get('retry-after'),
  }
}

async function main() {
  await new Promise((r) => fac.listen(FAC_PORT, r))
  redis = await startUpstashMock(REDIS_PORT)
  const app = spawn('npx', ['next', 'dev', '-p', String(APP_PORT)], {
    cwd: APP_ROOT,
    env: {
      ...process.env, X402_FACILITATOR_URL: `http://127.0.0.1:${FAC_PORT}`, CDP_API_KEY_ID: '', CDP_API_KEY_SECRET: '', NEXT_PUBLIC_CHAIN: 'base',
      UPSTASH_REDIS_REST_URL: `http://127.0.0.1:${REDIS_PORT}`, UPSTASH_REDIS_REST_TOKEN: 'mock', X402_RATE_LIMIT_PER_MINUTE: String(LIMIT),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const logs = []
  app.stdout.on('data', (d) => logs.push(String(d)))
  app.stderr.on('data', (d) => logs.push(String(d)))
  try {
    let first
    for (let i = 0; i < 120; i++) {
      try { first = await fetch(`${APP}/api/bet/status`); break } catch { await new Promise((r) => setTimeout(r, 1000)) }
    }
    const terms = await first.json()
    check('T1 no X-PAYMENT: 402 with discoverable terms', first.status === 402 && terms.accepts?.[0]?.outputSchema?.input?.discoverable === true)
    // A throwaway key: the mock facilitator accepts any well-formed payment.
    header = await createPaymentHeader(await createSigner('base', generatePrivateKey()), 1, terms.accepts[0])

    console.log('\nnon-2xx: verified, never settled')
    let r = await paid('/api/bet/quote')
    check('T2 quote, missing params: 400, not settled', r.status === 400 && r.verified === 1 && r.settled === 0, `${r.status} v${r.verified} s${r.settled}`)
    r = await paid('/api/bet/quote?gameId=NFL-2099-01-01-HOME-Nobody-AWAY-Nobody&side=home&stake=1')
    check('T3 quote, unknown gameId: 404, not settled', r.status === 404 && r.settled === 0, `${r.status} s${r.settled}`)
    r = await paid(`/api/bet/quote?gameId=${CLOSED_GAME}&side=home&stake=1`)
    check('T4 quote, market not open: 409, not settled', r.status === 409 && r.settled === 0, `${r.status} s${r.settled}`)
    r = await paid(`/api/bet/status?marketAddress=${SETTLED_MARKET}&bettor=nope`)
    check('T5 status, bad bettor: 400, not settled', r.status === 400 && r.settled === 0, `${r.status} s${r.settled}`)
    check('T5 no X-PAYMENT-RESPONSE on unsettled responses', r.paymentResponse === null)

    console.log('\n2xx: settled once, data released with X-PAYMENT-RESPONSE')
    r = await paid(`/api/bet/status?marketAddress=${SETTLED_MARKET}&bettor=${BETTOR}`)
    const pr = r.paymentResponse ? JSON.parse(Buffer.from(r.paymentResponse, 'base64').toString()) : null
    check('T6 status: 200, settled exactly once', r.status === 200 && r.verified === 1 && r.settled === 1, `${r.status} v${r.verified} s${r.settled}`)
    check('T6 status: body returned', Array.isArray(r.json?.bets))
    check('T6 X-PAYMENT-RESPONSE carries the settlement tx', pr?.success === true && pr?.transaction === TX, JSON.stringify(pr))
    r = await paid('/api/markets/agent')
    check('T7 agent: 200, settled exactly once', r.status === 200 && r.settled === 1 && Array.isArray(r.json?.markets), `${r.status} s${r.settled}`)

    console.log('\nsettlement failure: data withheld')
    mode = 'settle-fail'
    r = await paid(`/api/bet/status?marketAddress=${SETTLED_MARKET}&bettor=${BETTOR}`)
    check('T8 settle success:false -> 402, no bets in body', r.status === 402 && r.settled === 1 && r.json?.bets === undefined, `${r.status} ${r.text.slice(0, 120)}`)
    mode = 'settle-error'
    r = await paid(`/api/bet/status?marketAddress=${SETTLED_MARKET}&bettor=${BETTOR}`)
    check('T9 facilitator error on settle -> 402, no bets in body', r.status === 402 && r.json?.bets === undefined, `${r.status} ${r.text.slice(0, 120)}`)

    console.log('\ninvalid payment: handler never reached')
    mode = 'verify-invalid'
    r = await paid(`/api/bet/status?marketAddress=${SETTLED_MARKET}&bettor=${BETTOR}`)
    check('T10 verify invalid -> 402, not settled', r.status === 402 && r.settled === 0 && r.json?.error === 'invalid_exact_evm_payload_signature', `${r.status} ${r.json?.error}`)
    mode = 'ok'

    console.log(`\nrate limit (${LIMIT}/min): per IP before verify, per payer after verify`)
    redis.flush()
    const ipCodes = []
    for (let i = 0; i <= LIMIT; i++) ipCodes.push((await paid('/api/bet/status', { ip: '198.51.100.7', keep: true, payment: null })).status)
    check(`R1 per IP: ${LIMIT} answered, then 429`, ipCodes.slice(0, LIMIT).every((c) => c === 402) && ipCodes[LIMIT] === 429, ipCodes.join(','))

    redis.flush()
    const payerRuns = []
    for (let i = 0; i <= LIMIT; i++) payerRuns.push(await paid('/api/bet/quote', { ip: `198.51.100.${10 + i}`, keep: true }))
    const last = payerRuns[LIMIT]
    check(`R2 same payer from ${LIMIT + 1} IPs: ${LIMIT} answered 400, then 429`, payerRuns.slice(0, LIMIT).every((x) => x.status === 400) && last.status === 429, payerRuns.map((x) => x.status).join(','))
    check('R2 payer limit applies after verify: verified, never settled', last.verified === 1 && last.settled === 0, `v${last.verified} s${last.settled}`)
    check('R2 429 names the payer scope and sets Retry-After', last.json?.scope === 'payer' && Number(last.retryAfter) > 0, `${last.json?.scope} ${last.retryAfter}`)

    // A forged X-PAYMENT naming this payer fails verification and must not
    // spend their quota: LIMIT+1 forgeries, then their real request is served.
    redis.flush()
    mode = 'verify-invalid'
    const forged = []
    for (let i = 0; i <= LIMIT; i++) forged.push((await paid('/api/bet/quote', { ip: `192.0.2.${10 + i}`, keep: true })).status)
    mode = 'ok'
    r = await paid(`/api/bet/status?marketAddress=${SETTLED_MARKET}&bettor=${BETTOR}`, { ip: '192.0.2.99', keep: true })
    check(`R4 ${LIMIT + 1} forged headers for one payer: all 402`, forged.every((c) => c === 402), forged.join(','))
    check('R4 then the real payer is served and settled (quota untouched)', r.status === 200 && r.settled === 1, `${r.status} s${r.settled}`)

    redis.server.close()
    await new Promise((r) => setTimeout(r, 200))
    r = await paid(`/api/bet/status?marketAddress=${SETTLED_MARKET}&bettor=${BETTOR}`, { keep: true })
    check('R3 rate-limit store down: fails open, request still served and settled', r.status === 200 && r.settled === 1, `${r.status} s${r.settled}`)
  } finally {
    app.kill('SIGTERM')
    fac.close()
    redis?.server.close()
    if (failures) console.log('\n--- next dev log (tail) ---\n' + logs.join('').split('\n').slice(-40).join('\n'))
  }
  console.log(`\n${failures ? `${failures} FAILED` : 'ALL PASSED'}`)
  process.exit(failures ? 1 : 0)
}

await main().catch((err) => { console.error(err); process.exit(1) })
