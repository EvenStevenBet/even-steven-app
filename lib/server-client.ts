import { createPublicClient, http } from 'viem'
import { getChain } from '@/lib/chain'

// Server-side only — never exposed to browser.
// Uses SERVER_ALCHEMY_KEY (not NEXT_PUBLIC_ALCHEMY_KEY) so the key never ships to the client bundle.
// Fail loudly in production rather than degrading silently. Without this the
// missing-key case is indistinguishable from the working one — same block
// numbers, no warning — which is how server-side reads ran on the rate-limited
// public endpoint unnoticed until 2026-09-20. Dev still gets the fallback.
if (!process.env.SERVER_ALCHEMY_KEY && process.env.NODE_ENV === 'production') {
  throw new Error(
    'SERVER_ALCHEMY_KEY is not set. Refusing to fall back to the public RPC in ' +
      'production — it is rate-limited and will fail under load. Set it in the ' +
      'Vercel Production environment.'
  )
}

const rpcUrl = process.env.SERVER_ALCHEMY_KEY
  ? `https://base-mainnet.g.alchemy.com/v2/${process.env.SERVER_ALCHEMY_KEY}`
  : 'https://mainnet.base.org' // public fallback — rate-limited, DEV ONLY

export const serverPublicClient = createPublicClient({
  chain: getChain(),
  transport: http(rpcUrl),
})
