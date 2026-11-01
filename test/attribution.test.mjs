// The ERC-8021 builder-code suffix on every Even Steven transaction, byte for byte, and how calldata
// carrying either Even Steven code (current or legacy) is read back. Run with: npm run test:ref
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { attributionSuffix, refsFromCalldata, normalizeRef, isOwnBuilderCode, ES_BUILDER_CODE, ES_BUILDER_CODE_LEGACY } =
  await import(new URL('../lib/attribution.ts', import.meta.url).href)

// codes ∥ codesLength ∥ 0x00 ∥ 8021 x8, written out by hand (not built from the code under test).
const MARKER = '8021'.repeat(8)
const NEW_ONLY = '0x62635f32776b32367768300b00' + MARKER
const NEW_WITH_REF = '0x62635f32776b32367768302c616c6963652d7069636b73170080218021802180218021802180218021'
const LEGACY_ONLY = '0x62635f6e63797467696c780b00' + MARKER
const SELECTOR = '0xdeadbeef'
const ARGS = '00'.repeat(32) + '00'.repeat(31) + '05'

test('the codes are the ones Jeff set', () => {
  assert.equal(ES_BUILDER_CODE, 'bc_2wk26wh0')
  assert.equal(ES_BUILDER_CODE_LEGACY, 'bc_ncytgilx')
})

test('no ref: the suffix is exactly the expected bytes', () => {
  assert.equal(attributionSuffix(), '0x62635f32776b32367768300b0080218021802180218021802180218021')
  assert.equal(attributionSuffix(), NEW_ONLY)
  assert.equal(attributionSuffix(null), NEW_ONLY)
  assert.equal(attributionSuffix(undefined), NEW_ONLY)
})

test('with a ref: our code first, then the ref, comma-delimited, length covers both', () => {
  assert.equal(attributionSuffix('alice-picks'), NEW_WITH_REF)
})

test("neither Even Steven code is ever added as the ref, in any case", () => {
  for (const own of [ES_BUILDER_CODE, ES_BUILDER_CODE_LEGACY, ES_BUILDER_CODE.toUpperCase(), ES_BUILDER_CODE_LEGACY.toUpperCase()]) {
    assert.equal(attributionSuffix(own), NEW_ONLY, own)
  }
})

test('both codes are recognised as ours, in any case; nothing else is', () => {
  assert.equal(isOwnBuilderCode('bc_2wk26wh0'), true)
  assert.equal(isOwnBuilderCode('BC_2WK26WH0'), true)
  assert.equal(isOwnBuilderCode('bc_ncytgilx'), true)
  assert.equal(isOwnBuilderCode('Bc_NcYtGiLx'), true)
  assert.equal(isOwnBuilderCode('alice-picks'), false)
  assert.equal(isOwnBuilderCode('bc_2wk26wh'), false)
})

test('neither code survives as a ref', () => {
  for (const own of ['bc_2wk26wh0', 'BC_2WK26WH0', 'bc_ncytgilx', ' bc_ncytgilx ']) {
    assert.equal(normalizeRef(own), null, own)
  }
})

test('calldata with the new code and no ref reads back as no refs', () => {
  assert.deepEqual(refsFromCalldata(SELECTOR + ARGS + NEW_ONLY.slice(2)), [])
})

test('calldata with the OLD code in it is ignored: no ref, no points, no fee share', () => {
  assert.deepEqual(refsFromCalldata(SELECTOR + ARGS + LEGACY_ONLY.slice(2)), [])
})

test('a third-party ref is read back next to either of our codes', () => {
  assert.deepEqual(refsFromCalldata(SELECTOR + ARGS + NEW_WITH_REF.slice(2)), ['alice-picks'])
  const legacyWithRef = '0x62635f6e63797467696c782c616c6963652d7069636b73170080218021802180218021802180218021'
  assert.deepEqual(refsFromCalldata(SELECTOR + ARGS + legacyWithRef.slice(2)), ['alice-picks'])
})

test('a Smart Wallet bundle: the suffix inside handleOps, followed by ABI padding, still reads back', () => {
  const padding = '00'.repeat(28)
  assert.deepEqual(refsFromCalldata('0x1fad948c' + SELECTOR.slice(2) + ARGS + NEW_WITH_REF.slice(2) + padding), ['alice-picks'])
  assert.deepEqual(refsFromCalldata('0x1fad948c' + SELECTOR.slice(2) + ARGS + LEGACY_ONLY.slice(2) + padding), [])
})

test('the suffix round-trips through refsFromCalldata for any ref', () => {
  for (const ref of ['alice-picks', 'x'.repeat(32), '0x1164a458a716289c3d724fd1b3a8f5072593271e']) {
    assert.deepEqual(refsFromCalldata(SELECTOR + ARGS + attributionSuffix(ref).slice(2)), [ref])
  }
})
