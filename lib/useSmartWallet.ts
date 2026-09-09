'use client'

import { useAccount, useCapabilities } from 'wagmi'

// EIP-5792 atomic batch support (wallet_sendCalls) for the connected account on
// the current chain. 'supported' and 'ready' (EIP-7702 upgrade pending user
// approval — what Coinbase Smart Wallet reports for EOA-upgraded accounts on
// Base) both count as true — but only for the Coinbase Wallet connector.
// MetaMask/injected wallets have been observed reporting the capability
// without actually supporting it, then failing sendCalls at execution with
// "This Wallet does not support a capability that was not marked as
// optional." — so the connector check gates the capability check, not just
// the other way around. 'coinbaseWalletSDK' is the actual connector id in
// the installed @wagmi/connectors version (not 'coinbaseWallet' — verify
// against node_modules if this changes on a future upgrade). Never throws.
const COINBASE_WALLET_CONNECTOR_ID = 'coinbaseWalletSDK'

export function useIsSmartWallet(): boolean {
  const { address, chainId, connector } = useAccount()
  const { data: capabilities } = useCapabilities({
    account: address,
    query: { enabled: Boolean(address) },
  })

  if (connector?.id !== COINBASE_WALLET_CONNECTOR_ID) return false

  const status = chainId ? capabilities?.[chainId]?.atomic?.status : undefined
  return status === 'supported' || status === 'ready'
}
