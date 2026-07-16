import { base, baseSepolia } from 'viem/chains'
import type { Chain } from 'viem'

export function getChain(): Chain {
  return process.env.NEXT_PUBLIC_CHAIN === 'baseSepolia' ? baseSepolia : base
}

export const CHAIN_ID =
  process.env.NEXT_PUBLIC_CHAIN === 'baseSepolia' ? baseSepolia.id : base.id

export const FACTORY_ADDRESS =
  (process.env.NEXT_PUBLIC_FACTORY_ADDRESS ?? '') as `0x${string}`

export const USDC_ADDRESS =
  (process.env.NEXT_PUBLIC_USDC_ADDRESS ?? '') as `0x${string}`

export const APP_URL =
  process.env.NEXT_PUBLIC_APP_URL ?? 'https://evensteven.bet'

export const BASESCAN_URL =
  process.env.NEXT_PUBLIC_CHAIN === 'baseSepolia'
    ? 'https://sepolia.basescan.org'
    : 'https://basescan.org'
