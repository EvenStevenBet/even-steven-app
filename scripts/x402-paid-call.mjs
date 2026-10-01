// Makes one real x402-paid call to an Even Steven endpoint on Base mainnet and
// finds the settlement transaction. Dry run by default; pass --pay to sign.
//
//   node scripts/x402-paid-call.mjs <url>          # show the 402 terms only
//   node scripts/x402-paid-call.mjs <url> --pay    # 402 -> sign -> pay -> response
//
// Payer key: X402_TEST_PRIVATE_KEY, else BETTOR_PRIVATE_KEY from ~/.even-steven/.env.
// Refuses to pay unless the 402 asks for USDC on Base, to EXPECTED_PAY_TO, at most MAX_ATOMIC.

import fs from 'node:fs'
import os from 'node:os'
import { createPublicClient, http, parseAbiItem, getAddress, formatUnits } from 'viem'
import { base } from 'viem/chains'
import { createSigner } from 'x402/types'
import { createPaymentHeader } from 'x402/client'

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const EXPECTED_PAY_TO = getAddress(process.env.EXPECTED_PAY_TO ?? '0x6cF0A0b5282409E24dC35e2c1834f9111315603B')
const MAX_ATOMIC = BigInt(process.env.MAX_ATOMIC ?? 50_000) // $0.05

const url = process.argv[2]
const pay = process.argv.includes('--pay')
if (!url) throw new Error('usage: node scripts/x402-paid-call.mjs <url> [--pay]')

function payerKey() {
  let k = process.env.X402_TEST_PRIVATE_KEY
  if (!k) {
    const env = fs.readFileSync(`${os.homedir()}/.even-steven/.env`, 'utf8')
    k = env.match(/^BETTOR_PRIVATE_KEY="?([^"\n]+)/m)?.[1]?.trim()
  }
  if (!k) throw new Error('no payer key: set X402_TEST_PRIVATE_KEY or BETTOR_PRIVATE_KEY in ~/.even-steven/.env')
  return k.startsWith('0x') ? k : `0x${k}`
}

const first = await fetch(url)
const terms = await first.json().catch(() => null)
console.log(`GET ${url} -> ${first.status}`)
if (first.status !== 402 || !terms?.accepts?.length) {
  console.log(JSON.stringify(terms, null, 2))
  throw new Error('expected a 402 with payment requirements')
}
const req = terms.accepts[0]
console.log(`terms: ${formatUnits(BigInt(req.maxAmountRequired), 6)} USDC on ${req.network} to ${req.payTo}`)
console.log(`description: ${req.description}`)
console.log(`discoverable: ${req.outputSchema?.input?.discoverable === true}`)

if (req.network !== 'base' || getAddress(req.asset) !== USDC || getAddress(req.payTo) !== EXPECTED_PAY_TO) {
  throw new Error(`refusing to pay: unexpected terms ${JSON.stringify({ network: req.network, asset: req.asset, payTo: req.payTo })}`)
}
if (BigInt(req.maxAmountRequired) > MAX_ATOMIC) throw new Error(`refusing to pay ${req.maxAmountRequired} > cap ${MAX_ATOMIC}`)
if (!pay) { console.log('dry run — pass --pay to sign and pay'); process.exit(0) }

const signer = await createSigner('base', payerKey())
const payer = getAddress(signer.account.address)
const pub = createPublicClient({ chain: base, transport: http('https://mainnet.base.org') })
const fromBlock = await pub.getBlockNumber()
console.log(`payer: ${payer}`)

const header = await createPaymentHeader(signer, terms.x402Version, req)
const second = await fetch(url, { headers: { 'X-PAYMENT': header } })
const body = await second.text()
console.log(`GET with X-PAYMENT -> ${second.status}`)
console.log(body.length > 1500 ? `${body.slice(0, 1500)}…` : body)
const paymentResponse = second.headers.get('x-payment-response')
if (paymentResponse) console.log(`X-PAYMENT-RESPONSE: ${Buffer.from(paymentResponse, 'base64').toString()}`)

// The route settles before running its handler, so a non-402 means the payment settled.
// Find the USDC transfer payer -> payTo on-chain.
const transfer = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)')
for (let i = 0; i < 20; i++) {
  const logs = await pub.getLogs({ address: USDC, event: transfer, args: { from: payer, to: EXPECTED_PAY_TO }, fromBlock, toBlock: 'latest' })
  if (logs.length) {
    for (const l of logs) console.log(`settled: ${formatUnits(l.args.value, 6)} USDC ${payer} -> ${EXPECTED_PAY_TO}  https://basescan.org/tx/${l.transactionHash}`)
    process.exit(0)
  }
  await new Promise((r) => setTimeout(r, 3000))
}
console.log(`no USDC transfer ${payer} -> ${EXPECTED_PAY_TO} found since block ${fromBlock}`)
process.exit(1)
