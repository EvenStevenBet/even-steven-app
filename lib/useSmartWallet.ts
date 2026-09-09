'use client'

import { useAccount, useCapabilities } from 'wagmi'

// EIP-5792 atomic batch support (wallet_sendCalls) for the connected account on
// the current chain. 'supported' and 'ready' (EIP-7702 upgrade pending user
// approval — what Coinbase Smart Wallet reports for EOA-upgraded accounts on
// Base) both count as true. 'unsupported' or a missing/malformed capabilities
// shape fall back to the existing two-step EOA flow. Never throws.
export function useIsSmartWallet(): boolean {
  const { address, chainId } = useAccount()
  const { data: capabilities } = useCapabilities({
    account: address,
    query: { enabled: Boolean(address) },
  })

  const status = chainId ? capabilities?.[chainId]?.atomic?.status : undefined
  return status === 'supported' || status === 'ready'
}
