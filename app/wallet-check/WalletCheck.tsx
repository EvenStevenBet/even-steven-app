'use client'

import { useEffect, useState } from 'react'
import { useAccount, useCapabilities, useConnect, useDisconnect } from 'wagmi'
import { useWalletCapabilities } from '@/lib/useSmartWallet'
import { usePlatformLaunch } from '@/hooks/usePlatformLaunch'

// Diagnostic only — sends no transactions. Open it inside the Base App (or any wallet's
// in-app browser) to see what the WebView exposes and which path the bet slip would take.

const withTimeout = <T,>(p: Promise<T>, ms: number): Promise<T | 'TIMED OUT'> =>
  Promise.race([p, new Promise<'TIMED OUT'>((r) => setTimeout(() => r('TIMED OUT'), ms))])

type Flags = Record<string, unknown>

export function WalletCheck() {
  const { address, chainId, connector, isConnected } = useAccount()
  const { connectors, connect, error: connectError } = useConnect()
  const { disconnect } = useDisconnect()
  const { data: capabilities, error: capabilitiesError } = useCapabilities({ account: address, query: { enabled: Boolean(address) } })
  const decision = useWalletCapabilities()
  const platform = usePlatformLaunch()
  const [env, setEnv] = useState<Flags>({})
  const [farcaster, setFarcaster] = useState<Flags>({ status: 'checking…' })

  useEffect(() => {
    const eth = (window as { ethereum?: Record<string, unknown> & { providers?: unknown[] } }).ethereum
    setEnv({
      userAgent: navigator.userAgent,
      inIframe: window.self !== window.top,
      'window.ethereum': Boolean(eth),
      isCoinbaseWallet: eth?.isCoinbaseWallet ?? null,
      isCoinbaseBrowser: eth?.isCoinbaseBrowser ?? null,
      isMetaMask: eth?.isMetaMask ?? null,
      providers: Array.isArray(eth?.providers) ? eth.providers.length : null,
    })
    ;(async () => {
      try {
        const { sdk } = await import('@farcaster/miniapp-sdk')
        const [inMiniApp, context, provider] = await Promise.all([
          withTimeout(sdk.isInMiniApp(), 3000),
          withTimeout(Promise.resolve(sdk.context).then((c) => (c ? `client ${c.client?.clientFid ?? '?'}` : 'none')), 3000),
          withTimeout(sdk.wallet.getEthereumProvider().then((p) => (p ? 'provider returned' : 'none')), 3000),
        ])
        setFarcaster({ isInMiniApp: inMiniApp, context, 'wallet.getEthereumProvider': provider })
      } catch (err) {
        setFarcaster({ error: err instanceof Error ? err.message : String(err) })
      }
    })()
  }, [])

  const path = !isConnected
    ? 'connect a wallet to see'
    : decision.isSmartWallet
      ? `Smart Wallet batch (wallet_sendCalls), ${decision.paymaster ? 'paymaster attached (gasless)' : 'no paymaster: wallet did not report paymasterService'}`
      : 'approve, then placeBet (two transactions)'

  const rows: [string, unknown][] = [
    ['platform (MiniKit)', platform],
    ...Object.entries(env),
    ...Object.entries(farcaster).map(([k, v]) => [`farcaster ${k}`, v] as [string, unknown]),
    ['connected', isConnected],
    ['connector', connector ? `${connector.name} (id ${connector.id}, type ${connector.type})` : null],
    ['address', address ?? null],
    ['chainId', chainId ?? null],
    ['capabilities', capabilitiesError ? `error: ${capabilitiesError.message}` : capabilities?.[chainId ?? 0] ?? null],
    ['bet slip path', path],
  ]

  return (
    <main className="max-w-2xl mx-auto px-4 py-10 space-y-6">
      <h1 className="font-display text-2xl font-bold">Wallet check</h1>
      <p className="text-sm text-white/50">Diagnostics only. Nothing here sends a transaction. Screenshot this page and send it.</p>
      <div className="ticket p-4 text-xs font-mono space-y-1.5 break-all">
        {rows.map(([k, v]) => (
          <div key={k} className="grid grid-cols-[9rem_1fr] gap-2">
            <span className="text-white/40">{k}</span>
            <span className="text-white/85">{typeof v === 'object' ? JSON.stringify(v) : String(v)}</span>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        {isConnected ? (
          <button type="button" onClick={() => disconnect()} className="btn-ghost text-sm">Disconnect</button>
        ) : (
          connectors.map((c) => (
            <button key={c.uid} type="button" onClick={() => connect({ connector: c })} className="btn-ghost text-sm">
              Connect {c.name}
            </button>
          ))
        )}
      </div>
      {connectError && <p className="text-xs text-red-400">{connectError.message}</p>}
    </main>
  )
}
