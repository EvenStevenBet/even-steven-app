import { createConfig, http } from 'wagmi'
import { base, baseSepolia } from 'wagmi/chains'
import { coinbaseWallet, injected, walletConnect } from 'wagmi/connectors'

const isTestnet = process.env.NEXT_PUBLIC_CHAIN === 'baseSepolia'
const chain = isTestnet ? baseSepolia : base
const alchemyKey = process.env.NEXT_PUBLIC_ALCHEMY_KEY

function alchemyRpc(chainName: string) {
  if (!alchemyKey) return undefined
  return `https://${chainName}.g.alchemy.com/v2/${alchemyKey}` as const
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
    [base.id]:        http(alchemyRpc('base-mainnet')),
    [baseSepolia.id]: http(alchemyRpc('base-sepolia')),
  },
})

export { chain }
