// Preloaded into `next dev` (NODE_OPTIONS=--import) by the claim e2e test:
// sends every Base mainnet RPC request the app makes to the local fork instead,
// so the unmodified route code runs against forked state. Test-only.
const FORK = process.env.CLAIM_E2E_FORK_RPC ?? 'http://127.0.0.1:8545'
const MAINNET = /^https:\/\/(mainnet\.base\.org|base-mainnet\.g\.alchemy\.com\/v2\/[^/?#]*)/

const realFetch = globalThis.fetch
globalThis.fetch = (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  if (MAINNET.test(url)) return realFetch(FORK, init)
  return realFetch(input, init)
}
