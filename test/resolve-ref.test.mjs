// resolveRef / resolveRefForBettor against a TEST builder registry. The registry module is mocked,
// so nothing here reads or changes the real data/builders.json. Run with: npm run test:ref
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'

const PAYOUT = '0x1111111111111111111111111111111111111111'
const OTHER_PAYOUT = '0x2222222222222222222222222222222222222222'
const BETTOR = '0x3333333333333333333333333333333333333333'

mock.module(new URL('./builders-stub.mjs', import.meta.url).href, {
  defaultExport: [
    { code: 'Test-Capper', payoutAddress: PAYOUT, approved: true, label: 'test row, mixed-case code' },
    { code: 'not-approved', payoutAddress: OTHER_PAYOUT, approved: false },
    { code: 'string-true', payoutAddress: OTHER_PAYOUT, approved: 'true' },
    { code: 'bad-payout', payoutAddress: 'not-an-address', approved: true },
  ],
})

const { resolveRef, resolveRefForBettor } = await import(new URL('../lib/refs.ts', import.meta.url).href)

test('an approved code resolves to its builder and payout address', () => {
  assert.deepEqual(resolveRef('test-capper'), { type: 'builder', id: 'test-capper', payoutAddress: PAYOUT })
})

test('uppercase and padded forms of an approved code resolve to the same builder', () => {
  for (const raw of ['TEST-CAPPER', 'Test-Capper', '  test-capper  ']) {
    assert.deepEqual(resolveRef(raw), { type: 'builder', id: 'test-capper', payoutAddress: PAYOUT }, raw)
  }
})

test('an unapproved code resolves to nothing', () => {
  assert.equal(resolveRef('not-approved'), null)
  assert.equal(resolveRef('string-true'), null) // approved must be the boolean true
  assert.equal(resolveRef('bad-payout'), null) // approved but no valid payout address
  assert.equal(resolveRef('never-heard-of-it'), null)
})

test('invalid forms resolve to nothing', () => {
  for (const raw of ['ab', 'has space', 'x'.repeat(33), '<script>', 'under_score', '', '   ', null, undefined, 42, {}, []]) {
    assert.equal(resolveRef(raw), null, String(raw))
  }
})

test("Even Steven's own Base code is never a ref", () => {
  assert.equal(resolveRef('bc_ncytgilx'), null)
})

test('a wallet address is a ref of type address, any case', () => {
  assert.deepEqual(resolveRef(BETTOR), { type: 'address', id: BETTOR })
  assert.equal(resolveRef(BETTOR.toUpperCase().replace('0X', '0x'))?.type, 'address')
})

test("a bettor's own ref is dropped", () => {
  // a builder code whose payout address is the bettor
  assert.equal(resolveRefForBettor('test-capper', PAYOUT), null)
  assert.equal(resolveRefForBettor('TEST-CAPPER', PAYOUT.toUpperCase().replace('0X', '0x')), null)
  // the bettor's own address
  assert.equal(resolveRefForBettor(BETTOR, BETTOR), null)
})

test('a ref that pays someone else is kept', () => {
  assert.deepEqual(resolveRefForBettor('test-capper', BETTOR), { type: 'builder', id: 'test-capper', payoutAddress: PAYOUT })
  assert.deepEqual(resolveRefForBettor(OTHER_PAYOUT, BETTOR), { type: 'address', id: OTHER_PAYOUT })
})

test('an unapproved or invalid ref stays null for any bettor', () => {
  assert.equal(resolveRefForBettor('not-approved', BETTOR), null)
  assert.equal(resolveRefForBettor('ab', BETTOR), null)
})
