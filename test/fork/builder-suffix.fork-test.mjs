// Fork test of the Even Steven builder-code suffix on every transaction path, against a Base
// mainnet fork. Funded TEST accounts only; no key is read, nothing can reach mainnet (the fork
// executes every transaction locally, upstream sees reads only).
//
//   terminal 1 (protocol repo checkout next to this one):
//     cd repo/scripts/fork-tests
//     ALCHEMY_RPC_URL=https://mainnet.base.org FORK_BLOCK=<recent block> npx hardhat node --port 8548
//   terminal 2 (from the app repo):
//     FORK_RPC=http://127.0.0.1:8548 node --experimental-test-module-mocks --no-warnings \
//       --import ./test/alias-loader.mjs test/fork/builder-suffix.fork-test.mjs
//
// Paths covered, each asserting the calldata ends in the exact suffix and the market call succeeded:
//   1. web EOA        approve + placeBet through lib/eoa-bet.ts placeBetEoa (the app's own function)
//   2. web Smart Wallet  placeBet calldata with the suffix concatenated, as components/BetSlip.tsx builds it
//   3. relay          placeBetFor (v, r, s) and placeBetForWithSignature (bytes), with and without a ref,
//                     as app/api/bet/route.ts builds them
//   4. relayed claim  claimPayoutFor as lib/claim.ts builds it (market settled on the fork through UMA)

import fs from 'node:fs'
import { createWalletClient, concat, encodeFunctionData, http, keccak256, parseAbi, parseEventLogs, toHex, pad } from 'viem'
import { base } from 'viem/chains'

const HARNESS = new URL('../../../repo/scripts/fork-tests/lib/chain.mjs', import.meta.url).href
const { pub, test, wallet, acct, assertFreshActors, mintUSDC, setBalanceEth, increaseTime, signAuthorization, USDC, RPC_LOCAL } =
  await import(HARNESS)
const { attributionSuffix, refsFromCalldata, ES_BUILDER_CODE, ES_BUILDER_CODE_LEGACY } =
  await import(new URL('../../lib/attribution.ts', import.meta.url).href)
const { placeBetEoa } = await import(new URL('../../lib/eoa-bet.ts', import.meta.url).href)
const { marketAbi, erc20Abi } = await import(new URL('../../lib/contracts.ts', import.meta.url).href)

const FACTORY = '0x5906370b9831728ec523b647137a1bbf0ab45390'
const V4_OWNER = '0x28953e3FCCfC0Ae1c4d5899c795Df41667c5B336'
const NEW_ONLY = '0x62635f32776b32367768300b0080218021802180218021802180218021'
const REF = 'alice-picks'
const NEW_WITH_REF = '0x62635f32776b32367768302c616c6963652d7069636b73170080218021802180218021802180218021'
const MAX = (1n << 256n) - 1n
const USD = (n) => BigInt(Math.round(n * 1e6))

const factoryAbi = parseAbi([
  'function createMarket(string gameId, int256 oracleZ, uint256 protocolSeed) returns (address)',
  'event MarketCreated(address indexed market, string gameId, int256 oracleZ, int256 spreadMax, int256 spreadMin, uint256 feePercent, address indexed creator)',
])
const settleAbi = parseAbi([
  'function closeBetting()', 'function requestSettlement(int256 finalSpread)', 'function executeSettlement()',
  'event PayoutClaimed(address indexed bettor, uint256 totalPayout)',
])

let fails = 0
const check = (ok, label, extra = '') => { console.log(ok ? 'PASS' : 'FAIL', label, extra); if (!ok) fails++ }
const rows = []

if (!String(await pub.request({ method: 'web3_clientVersion', params: [] })).includes('HardhatNetwork')) {
  throw new Error(`${RPC_LOCAL} is not a Hardhat fork; refusing to run`)
}
console.log(`fork ${RPC_LOCAL}  chainId ${await pub.getChainId()}  block ${await pub.getBlockNumber()}`)
console.log(`codes: current ${ES_BUILDER_CODE}  legacy ${ES_BUILDER_CODE_LEGACY}`)

// ── actors: fresh keys, funded on the fork only ───────────────────────────
await assertFreshActors(6)
const [webEoa, smartWallet, relayBettor, sigBettor, relay] = [1, 2, 3, 4, 5].map(acct)
for (const a of [webEoa, smartWallet, relayBettor, sigBettor, relay]) await setBalanceEth(a.address, 10n ** 19n)
for (const a of [webEoa, smartWallet, relayBettor, sigBettor]) await mintUSDC(a.address, USD(1000))
const as = { web: webEoa.address, sw: smartWallet.address, rb: relayBettor.address, sb: sigBettor.address, relay: relay.address }
console.log('test accounts (fork only):', as)

// ── a fresh Factory v1.6 market, created by the owner on the fork ─────────
await test.impersonateAccount({ address: V4_OWNER })
await setBalanceEth(V4_OWNER, 10n ** 19n)
await mintUSDC(V4_OWNER, USD(5000))
const owner = createWalletClient({ account: V4_OWNER, chain: base, transport: http(RPC_LOCAL), pollingInterval: 20 })
const wait = (hash) => pub.waitForTransactionReceipt({ hash })
check((await pub.readContract({ address: FACTORY, abi: parseAbi(['function owner() view returns (address)']), functionName: 'owner' })).toLowerCase() === V4_OWNER.toLowerCase(), 'factory owner on the fork is v4')
await wait(await owner.writeContract({ address: USDC, abi: erc20Abi, functionName: 'approve', args: [FACTORY, MAX] }))
const created = await wait(await owner.writeContract({
  address: FACTORY, abi: factoryAbi, functionName: 'createMarket', args: [`NFL-2026-11-01-HOME-Forkers-AWAY-Testers-${Date.now() % 100000}`, 0n, USD(1)],
}))
const market = parseEventLogs({ abi: factoryAbi, eventName: 'MarketCreated', logs: created.logs })[0].args.market
console.log('fork market', market)

const inputOf = async (hash) => (await pub.getTransaction({ hash })).input
async function assertSuffix(path, hash, expected, refs) {
  const receipt = await pub.getTransactionReceipt({ hash })
  const input = await inputOf(hash)
  const tail = input.slice(-(expected.length - 2))
  check(receipt.status === 'success', `${path}: tx succeeded`, hash)
  check(input.toLowerCase().endsWith(expected.slice(2)), `${path}: calldata ends in the expected suffix`)
  check(JSON.stringify(refsFromCalldata(input)) === JSON.stringify(refs), `${path}: refsFromCalldata -> ${JSON.stringify(refs)} (our codes dropped)`)
  rows.push({ path, hash, suffix: `0x${tail}`, refs })
  return receipt
}
const betLog = (receipt) => parseEventLogs({ abi: marketAbi, eventName: 'BetPlaced', logs: receipt.logs.filter((l) => l.address.toLowerCase() === market.toLowerCase()) })

// ── 1. web EOA: the app's own placeBetEoa, approve + placeBet ─────────────
{
  const w = wallet(webEoa)
  const sent = []
  const writeContract = async (args) => { const h = await w.writeContract(args); sent.push(h); return h }
  const stake = USD(5)
  const { hash, receipt } = await placeBetEoa({
    publicClient: pub, writeContract, account: webEoa.address, usdc: USDC, market, greaterThan: true, stake,
    totalCost: stake + (stake * 200n) / 10000n, betSuffix: attributionSuffix(REF), approveSuffix: attributionSuffix(),
    onStep: () => {}, allowanceWaitMs: 5000, sleep: async () => {},
  })
  check(sent.length === 2, 'web EOA: two transactions (approve, then placeBet)')
  await assertSuffix('web EOA approve', sent[0], NEW_ONLY, [])
  await assertSuffix('web EOA placeBet (with ref)', hash, NEW_WITH_REF, [REF])
  check(betLog(receipt).length === 1, 'web EOA: one BetPlaced')
}

// ── 2. web Smart Wallet: placeBet calldata + suffix, as BetSlip.tsx concatenates it ──
{
  const w = wallet(smartWallet)
  await wait(await w.writeContract({ address: USDC, abi: erc20Abi, functionName: 'approve', args: [market, MAX] }))
  const placeBetCalldata = encodeFunctionData({ abi: marketAbi, functionName: 'placeBet', args: [false, USD(5)] })
  const betCalldata = concat([placeBetCalldata, attributionSuffix()])
  const hash = await w.sendTransaction({ to: market, data: betCalldata })
  const receipt = await assertSuffix('web Smart Wallet placeBet (no ref)', hash, NEW_ONLY, [])
  check(betLog(receipt).length === 1, 'web Smart Wallet: one BetPlaced')
  const withRef = concat([placeBetCalldata, attributionSuffix(REF)])
  const h2 = await w.sendTransaction({ to: market, data: withRef })
  await assertSuffix('web Smart Wallet placeBet (with ref)', h2, NEW_WITH_REF, [REF])
}

// ── 3. relay: placeBetFor (v,r,s) and placeBetForWithSignature (bytes), the relay pays gas ──
const relayW = wallet(relay)
async function relayBet(kind, bettor, greaterThan, ref) {
  const stake = USD(5), fee = (stake * 200n) / 10000n
  const salt = keccak256(toHex(`${kind}-${ref ?? 'none'}-${Date.now()}`))
  const auth = await signAuthorization({ signer: bettor, market, value: stake + fee, salt, greaterThan })
  const dataSuffix = attributionSuffix(ref)
  const common = { address: market, abi: marketAbi, account: relay, dataSuffix }
  const { request } = kind === 'placeBetFor'
    ? await pub.simulateContract({ ...common, functionName: 'placeBetFor', args: [bettor.address, greaterThan, stake, { validAfter: auth.validAfter, validBefore: auth.validBefore, nonce: auth.nonce, salt, v: auth.v, r: auth.r, s: auth.s }] })
    : await pub.simulateContract({ ...common, functionName: 'placeBetForWithSignature', args: [bettor.address, greaterThan, stake, { validAfter: auth.validAfter, validBefore: auth.validBefore, nonce: auth.nonce, salt, signature: auth._sig }] })
  const hash = await relayW.writeContract(request)
  const receipt = await assertSuffix(`relay ${kind} (${ref ? 'with ref' : 'no ref'})`, hash, ref ? NEW_WITH_REF : NEW_ONLY, ref ? [ref] : [])
  const ev = betLog(receipt)
  check(ev.length === 1 && ev[0].args.bettor.toLowerCase() === bettor.address.toLowerCase(), `relay ${kind}: BetPlaced bettor is the signer, not the relay`)
  const usdcTransfers = parseEventLogs({ abi: erc20Abi, eventName: 'Transfer', logs: receipt.logs.filter((l) => l.address.toLowerCase() === USDC.toLowerCase()) })
  check(!usdcTransfers.some((t) => t.args.from === relay.address || t.args.to === relay.address), `relay ${kind}: relay never touched USDC`)
  return receipt
}
await relayBet('placeBetFor', relayBettor, false, REF)
await relayBet('placeBetFor', relayBettor, false, undefined)
await relayBet('placeBetForWithSignature', sigBettor, true, undefined)
await relayBet('placeBetForWithSignature', sigBettor, true, REF)

// ── 4. relayed claim: settle on the fork, then claimPayoutFor from the relay ──
await wait(await owner.writeContract({ address: USDC, abi: erc20Abi, functionName: 'approve', args: [market, MAX] })) // UMA bond
for (const [fn, args] of [['closeBetting', []], ['requestSettlement', [50n]]]) {
  await wait(await owner.writeContract({ address: market, abi: settleAbi, functionName: fn, args }))
}
await increaseTime(7200 + 100)
await wait(await owner.writeContract({ address: market, abi: settleAbi, functionName: 'executeSettlement', args: [] }))
const state = await pub.readContract({ address: market, abi: marketAbi, functionName: 'getMarketState' })
check(state[6] === true, 'market settled on the fork (greater side wins)')

for (const winner of [webEoa, sigBettor]) {
  const ids = await pub.readContract({ address: market, abi: marketAbi, functionName: 'getBetsByAddress', args: [winner.address] })
  const claimable = []
  for (const id of ids) {
    const bet = await pub.readContract({ address: market, abi: marketAbi, functionName: 'getBet', args: [id] })
    if (bet.greaterThan && !bet.claimed) claimable.push(id)
  }
  const before = await pub.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [winner.address] })
  const { request } = await pub.simulateContract({
    address: market, abi: marketAbi, functionName: 'claimPayoutFor', args: [winner.address, claimable], account: relay,
    dataSuffix: attributionSuffix(), // exactly as lib/claim.ts
  })
  const hash = await relayW.writeContract(request)
  const receipt = await assertSuffix(`relayed claimPayoutFor (${winner.address.slice(0, 8)}…)`, hash, NEW_ONLY, [])
  const after = await pub.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [winner.address] })
  check(after > before, `claimPayoutFor paid the bettor, not the relay`, `+${after - before} base units`)
  check(receipt.logs.every((l) => !(l.address.toLowerCase() === USDC.toLowerCase() && l.topics[2]?.toLowerCase().endsWith(relay.address.slice(2).toLowerCase()))), 'claim: no USDC to the relay')
}

// ── static: the Smart Wallet capability stays optional ────────────────────
const betSlip = fs.readFileSync(new URL('../../components/BetSlip.tsx', import.meta.url), 'utf8')
check(/dataSuffix:\s*\{\s*value:\s*dataSuffix,\s*optional:\s*true\s*\}/.test(betSlip), 'BetSlip.tsx: dataSuffix capability is still { value, optional: true }')
check(betSlip.includes('concat([placeBetCalldata, dataSuffix])'), 'BetSlip.tsx: placeBet call carries the suffix inline')

console.log('\n=== decoded suffixes (the last bytes of each transaction input) ===')
for (const r of rows) console.log(`${r.path.padEnd(48)} ${r.hash}\n  ${r.suffix}\n  third-party refs: ${r.refs.length ? r.refs.join(', ') : '(none)'}`)
console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`)
process.exit(fails ? 1 : 0)
