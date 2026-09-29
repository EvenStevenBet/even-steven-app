import { createConfig, fallback, http } from 'wagmi'
import { base, baseSepolia } from 'wagmi/chains'
import { coinbaseWallet, injected, walletConnect } from 'wagmi/connectors'

const isTestnet = process.env.NEXT_PUBLIC_CHAIN === 'baseSepolia'
const chain = isTestnet ? baseSepolia : base
const alchemyKey = process.env.NEXT_PUBLIC_ALCHEMY_KEY

// Alchemy first, then the chain's public RPC. If the browser key is rate-limited, blocked by
// an extension, or down, reads (the bet slip's market state, balances) keep working instead
// of hanging on "Checking market status…". Wallet writes go through the wallet, not these.
function transport(chainName: string, publicUrl: string) {
  const publicRpc = http(publicUrl, { retryCount: 1, timeout: 10_000 })
  if (!alchemyKey) return publicRpc
  return fallback([
    http(`https://${chainName}.g.alchemy.com/v2/${alchemyKey}`, { retryCount: 1, timeout: 8_000 }),
    publicRpc,
  ])
}

export const wagmiConfig = createConfig({
  chains: [chain],
  ssr: true, // required for Next.js to avoid hydration mismatch
  connectors: [
    // Featured: Coinbase Smart Wallet (one-tap, gasless via Paymaster in Stage 2)
    coinbaseWallet({
      appName: 'Even Steven',
      appLogoUrl: `${process.env.NEXT_PUBLIC_APP_URL ?? 'https://evensteven.bet'}/icon.png`,
      preference: 'all', // shows Smart Wallet first, falls back to EOA
    }),
    // Fallback: MetaMask / other injected wallets
    injected({ shimDisconnect: true }),
    // Fallback: WalletConnect
    walletConnect({
      projectId: process.env.NEXT_PUBLIC_WC_PROJECT_ID ?? 'placeholder',
      metadata: {
        name: 'Even Steven',
        description: 'Parimutuel sports betting on Base',
        url: process.env.NEXT_PUBLIC_APP_URL ?? 'https://evensteven.bet',
        icons: [`${process.env.NEXT_PUBLIC_APP_URL ?? 'https://evensteven.bet'}/icon.png`],
      },
    }),
  ],
  transports: {
    [base.id]:        transport('base-mainnet', 'https://mainnet.base.org'),
    [baseSepolia.id]: transport('base-sepolia', 'https://sepolia.base.org'),
  },
})

export { chain }
