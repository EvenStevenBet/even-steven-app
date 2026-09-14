'use client'

import { useEffect, useRef, useState } from 'react'
import { BaseError } from 'viem'
import { useAccount, useConnect } from 'wagmi'
import {
  ConnectWallet,
  Wallet,
  WalletDropdown,
  WalletDropdownDisconnect,
} from '@coinbase/onchainkit/wallet'
import { Address, Avatar, Identity, Name } from '@coinbase/onchainkit/identity'

// viem wraps wallet rejections and contract reverts in BaseError with a
// human-readable shortMessage — same pattern as components/BetSlip.tsx.
function describeError(err: unknown): string {
  if (err instanceof BaseError) return err.shortMessage
  return err instanceof Error ? err.message : 'Something went wrong.'
}

/**
 * Connect-wallet control shared by Header and the /bets connect prompt.
 *
 * OnchainKit's <ConnectWallet> only surfaces Coinbase Wallet, which locks out
 * MetaMask/WalletConnect users anywhere it's the sole disconnected-state UI.
 * The disconnected state here is a custom dropdown over wagmi's useConnect()
 * (same pattern BetSlip.tsx already uses correctly) listing every configured
 * connector. The connected state keeps OnchainKit's <Wallet>/<WalletDropdown>
 * as-is — that part already works (ENS name / avatar / disconnect).
 */
export function ConnectWalletModal() {
  const { isConnected } = useAccount()
  const {
    connect,
    connectors,
    isPending: isConnecting,
    error: connectError,
    variables: connectVariables,
  } = useConnect()
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open])

  // Close on successful connection.
  useEffect(() => {
    if (isConnected) setOpen(false)
  }, [isConnected])

  if (isConnected) {
    return (
      <Wallet>
        <ConnectWallet>
          <Avatar className="h-5 w-5" />
          <Name />
        </ConnectWallet>
        <WalletDropdown>
          <Identity className="px-4 pt-3 pb-2" hasCopyAddressOnClick>
            <Avatar />
            <Name />
            <Address />
          </Identity>
          <WalletDropdownDisconnect />
        </WalletDropdown>
      </Wallet>
    )
  }

  return (
    <div className="relative inline-block" ref={containerRef}>
      <button type="button" onClick={() => setOpen(o => !o)} className="btn-gold text-sm px-4 py-2">
        Connect Wallet
      </button>
      {open && (
        <div className="absolute right-0 mt-2 w-64 rounded-md border border-white/10 bg-[#111] p-3 space-y-2 shadow-lg z-50">
          <p className="text-xs text-white/50 uppercase tracking-widest font-display text-center">
            Connect a wallet
          </p>
          {connectors.map(connector => {
            const isThisConnecting = isConnecting && connectVariables?.connector === connector
            return (
              <button
                key={connector.uid}
                type="button"
                onClick={() => connect({ connector })}
                disabled={isConnecting}
                className="w-full py-2.5 px-3 rounded-md border border-white/10 text-sm font-display font-semibold text-white/80 text-left transition-colors hover:border-gold/40 hover:text-gold disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {isThisConnecting ? `Connecting to ${connector.name}…` : connector.name}
              </button>
            )
          })}
          {connectError && (
            <p className="text-xs text-red-400 text-center">{describeError(connectError)}</p>
          )}
        </div>
      )}
    </div>
  )
}
