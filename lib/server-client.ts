import { createPublicClient, http } from 'viem'
import { getChain } from '@/lib/chain'

// Server-side only — never exposed to browser.
// Uses SERVER_ALCHEMY_KEY (not NEXT_PUBLIC_ALCHEMY_KEY) so the key never ships to the client bundle.
const rpcUrl = process.env.SERVER_ALCHEMY_KEY
  ? `https://base-mainnet.g.alchemy.com/v2/${process.env.SERVER_ALCHEMY_KEY}`
  : 'https://mainnet.base.org' // public fallback — rate-limited, dev only

export const serverPublicClient = createPublicClient({
  chain: getChain(),
  transport: http(rpcUrl),
})
