import { createWalletClient, http, getAddress, parseEther, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { getChain } from '@/lib/chain'
import { serverPublicClient } from '@/lib/server-client'

// Server-side only. The relay submits a bettor's signed EIP-3009 authorization
// to placeBetFor / placeBetForWithSignature / claimPayoutFor and pays the ETH
// gas. USDC moves bettor -> market and market -> bettor directly; the relay is
// never a party to a USDC transfer and must never hold USDC.

// Addresses that must never be the relay: an owner receives the 2% taker fees
// and seed returns, and the x402 receiver is paid in USDC — a relay key that is
// also one of those would put USDC custody and the gas-paying hot key in one place.
const FORBIDDEN_RELAY_ADDRESSES = [
  '0x2e5Ff49699f0dA2E8A6a43f34BffC1c740E67916', // owner, Factory v1.6 + all its markets
  '0x6cF0A0b5282409E24dC35e2c1834f9111315603B', // owner, Factory v1.5 era
]

// `next build` imports route modules with NODE_ENV=production to collect page
// data; these only have to hold where requests are actually served.
const isBuildPhase = process.env.NEXT_PHASE === 'phase-production-build'

if (
  !isBuildPhase &&
  process.env.SERVER_ALCHEMY_KEY &&
  process.env.SERVER_ALCHEMY_KEY === process.env.NEXT_PUBLIC_ALCHEMY_KEY
) {
  throw new Error('SERVER_ALCHEMY_KEY and NEXT_PUBLIC_ALCHEMY_KEY must be different API keys')
}

if (!process.env.RELAY_PRIVATE_KEY && process.env.NODE_ENV === 'production' && !isBuildPhase) {
  throw new Error(
    'RELAY_PRIVATE_KEY is not set. POST /api/bet cannot submit relayed bets. ' +
      'Set it in the Vercel Production environment.'
  )
}

const rpcUrl = process.env.SERVER_ALCHEMY_KEY
  ? `https://base-mainnet.g.alchemy.com/v2/${process.env.SERVER_ALCHEMY_KEY}`
  : 'https://mainnet.base.org' // public fallback — DEV ONLY (lib/server-client.ts throws in production)

const rawRelayKey = process.env.RELAY_PRIVATE_KEY?.trim()
// Wallet exports often omit the 0x prefix.
export const relayAccount = rawRelayKey
  ? privateKeyToAccount((rawRelayKey.startsWith('0x') ? rawRelayKey : `0x${rawRelayKey}`) as Hex)
  : null

if (relayAccount) {
  const forbidden = [
    ...FORBIDDEN_RELAY_ADDRESSES,
    ...(process.env.X402_RECEIVING_ADDRESS ? [process.env.X402_RECEIVING_ADDRESS] : []),
  ].map((a) => getAddress(a))
  if (forbidden.includes(relayAccount.address)) {
    throw new Error(
      `RELAY_PRIVATE_KEY derives ${relayAccount.address}, which is an owner or x402 receiving ` +
        'address. The relay must be a dedicated ETH-only wallet.'
    )
  }
}

export const relayWalletClient = relayAccount
  ? createWalletClient({ account: relayAccount, chain: getChain(), transport: http(rpcUrl) })
  : null

export const RELAY_MIN_ETH = parseEther(process.env.RELAY_MIN_ETH ?? '0.002')

export async function getRelayEthBalance(): Promise<bigint> {
  if (!relayAccount) throw new Error('relay not configured')
  return serverPublicClient.getBalance({ address: relayAccount.address })
}
