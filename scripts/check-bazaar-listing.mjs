// Checks the public x402 Bazaar (CDP discovery) for Even Steven's paid endpoints.
// Usage: node scripts/check-bazaar-listing.mjs [payTo]
// Exits 1 unless all three paid endpoints are listed under payTo.
//
// A resource is catalogued only after a payment for it settles through the CDP
// facilitator with discoverable: true, so an empty listing before the CDP keys
// are live (or before the first paid call per endpoint) is expected.

const PAY_TO = process.argv[2] ?? process.env.X402_RECEIVING_ADDRESS ?? '0x6cF0A0b5282409E24dC35e2c1834f9111315603B'
const BASE = 'https://api.cdp.coinbase.com/platform/v2/x402/discovery/merchant'
const EXPECTED = ['/api/markets/agent', '/api/bet/quote', '/api/bet/status']

const resources = []
for (let offset = 0; ; offset += 20) {
  const res = await fetch(`${BASE}?payTo=${PAY_TO}&limit=20&offset=${offset}`)
  if (!res.ok) throw new Error(`discovery API ${res.status}: ${await res.text()}`)
  const page = await res.json()
  resources.push(...page.resources)
  if (resources.length >= page.pagination.total || page.resources.length === 0) break
}

console.log(`payTo ${PAY_TO}: ${resources.length} listed resource(s)`)
for (const r of resources) console.log(`  ${r.resource}  (updated ${r.lastUpdated ?? '?'})`)

const listedPaths = resources.map((r) => { try { return new URL(r.resource).pathname } catch { return r.resource } })
const missing = EXPECTED.filter((p) => !listedPaths.includes(p))
if (missing.length) {
  console.log(`missing: ${missing.join(', ')}`)
  process.exit(1)
}
console.log('all three paid endpoints are listed')
