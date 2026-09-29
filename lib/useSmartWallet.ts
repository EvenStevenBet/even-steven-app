'use client'

import { useAccount, useCapabilities } from 'wagmi'

// EIP-5792 capabilities of the connected wallet on the current chain.
//
// Atomic batching ('supported', or 'ready' for an EIP-7702 upgrade pending approval) is only
// trusted from Coinbase's own wallets: MetaMask/injected wallets have been observed reporting
// the capability without supporting it, then failing sendCalls at execution. "Coinbase's own"
// means the Coinbase Wallet SDK connector ('coinbaseWalletSDK' in the installed
// @wagmi/connectors), or the provider injected by the Base App / Coinbase Wallet in-app browser
// — which the SDK connector itself hands back in that environment (isCoinbaseBrowser).
//
// paymaster is true only when the wallet itself reports paymasterService support. A wallet
// must reject a whole sendCalls batch that carries a capability it doesn't support, so the
// paymaster may only be attached when this is true.
const COINBASE_WALLET_CONNECTOR_ID = 'coinbaseWalletSDK'

type InjectedFlags = { isCoinbaseWallet?: boolean; isCoinbaseBrowser?: boolean }

export function isCoinbaseInjected(): boolean {
  if (typeof window === 'undefined') return false
  const eth = (window as { ethereum?: InjectedFlags }).ethereum
  return Boolean(eth?.isCoinbaseWallet || eth?.isCoinbaseBrowser)
}

function isCoinbaseFamily(connectorId: string | undefined): boolean {
  return connectorId === COINBASE_WALLET_CONNECTOR_ID || (connectorId === 'injected' && isCoinbaseInjected())
}

export interface WalletCapabilities {
  isSmartWallet: boolean
  paymaster: boolean
}

export function useWalletCapabilities(): WalletCapabilities {
  const { address, chainId, connector } = useAccount()
  const { data: capabilities } = useCapabilities({
    account: address,
    query: { enabled: Boolean(address) },
  })

  if (!isCoinbaseFamily(connector?.id)) return { isSmartWallet: false, paymaster: false }

  const caps = chainId ? capabilities?.[chainId] : undefined
  const status = caps?.atomic?.status
  return {
    isSmartWallet: status === 'supported' || status === 'ready',
    paymaster: caps?.paymasterService?.supported === true,
  }
}
