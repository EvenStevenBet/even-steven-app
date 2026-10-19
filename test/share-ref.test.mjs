// The ref a bet carries, with session storage working, blocked, and the address bar changing.
// Run with: npm run test:ref
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

const { captureRefFromUrl, getStoredRef, resetRefMemory } =
  await import(new URL('../lib/share-ref.ts', import.meta.url).href)
const { attributionSuffix, ES_BUILDER_CODE } = await import(new URL('../lib/attribution.ts', import.meta.url).href)

function browser({ search = '', blocked = false, initial = {} } = {}) {
  const data = { ...initial }
  const storage = blocked
    ? { getItem() { throw new Error('SecurityError') }, setItem() { throw new Error('SecurityError') } }
    : { getItem: k => data[k] ?? null, setItem: (k, v) => { data[k] = v } }
  globalThis.window = { location: { search } }
  globalThis.sessionStorage = storage
  return { navigate: s => { globalThis.window.location.search = s }, data }
}

beforeEach(() => { resetRefMemory(); delete globalThis.window; delete globalThis.sessionStorage })

test('storage works: the captured ref is read back, as before', () => {
  const b = browser({ search: '?ref=alice-picks' })
  captureRefFromUrl()
  b.navigate('')
  assert.equal(getStoredRef(), 'alice-picks')
  assert.equal(b.data['es:ref'], 'alice-picks')
})

test('storage blocked, ref in the URL at bet time: the address bar supplies it', () => {
  browser({ search: '?side=home&ref=alice-picks', blocked: true })
  assert.equal(getStoredRef(), 'alice-picks') // no capture ran, e.g. the bet slip opened first
})

test('storage blocked, after in-page navigation: the in-memory copy supplies it', () => {
  const b = browser({ search: '?ref=alice-picks', blocked: true })
  captureRefFromUrl() // landing page
  b.navigate('') // client-side navigation drops the query
  assert.equal(getStoredRef(), 'alice-picks')
})

test('a full page load without the ref forgets the memory copy, as before', () => {
  const b = browser({ search: '?ref=alice-picks', blocked: true })
  captureRefFromUrl()
  b.navigate('')
  resetRefMemory()
  assert.equal(getStoredRef(), null)
})

test('no ref anywhere: no code, and the transaction carries only the Even Steven attribution', () => {
  browser({ search: '', blocked: true })
  assert.equal(getStoredRef(), null)
  assert.equal(attributionSuffix(getStoredRef()), attributionSuffix())
  const hex = attributionSuffix(getStoredRef())
  assert.equal(Buffer.from(hex.slice(2, 2 + ES_BUILDER_CODE.length * 2), 'hex').toString(), ES_BUILDER_CODE)
})

test('invalid codes are ignored everywhere, storage blocked or not', () => {
  for (const bad of ['ab', 'has%20space', 'x'.repeat(33), '%3Cscript%3E', 'under_score', '']) {
    for (const blocked of [true, false]) {
      resetRefMemory()
      const b = browser({ search: `?ref=${bad}`, blocked })
      captureRefFromUrl()
      b.navigate('')
      assert.equal(getStoredRef(), null, `ref=${bad} blocked=${blocked}`)
    }
  }
})

test('an invalid code never replaces a valid one already held', () => {
  const b = browser({ search: '?ref=alice-picks', blocked: true })
  captureRefFromUrl()
  b.navigate('?ref=ab')
  captureRefFromUrl()
  assert.equal(getStoredRef(), 'alice-picks')
})

test('codes are lowercased by the existing validation', () => {
  browser({ search: '?ref=Alice-Picks', blocked: true })
  assert.equal(getStoredRef(), 'alice-picks')
})
