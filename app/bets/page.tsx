// Stage 1 placeholder — full bet history + claim UI ships in Stage 2.
// Requires a connected wallet; shows a connect prompt otherwise.
'use client'

import Link from 'next/link'
import { useAccount } from 'wagmi'
import {
  ConnectWallet,
  Wallet,
  WalletDropdown,
  WalletDropdownDisconnect,
} from '@coinbase/onchainkit/wallet'

export default function BetsPage() {
  const { isConnected } = useAccount()

  return (
    <main className="max-w-2xl mx-auto px-4 py-20 text-center space-y-6">
      <div
        className="font-display text-7xl font-bold text-gold/20 leading-none select-none"
        aria-hidden
      >
        =
      </div>
      <h1 className="font-display text-3xl font-bold">My Bets</h1>

      {isConnected ? (
        <div className="space-y-4">
          <p className="text-white/50">
            Bet history and claims will be available here once markets go live.
          </p>
          <Link href="/" className="btn-ghost text-sm inline-flex">
            ← Browse markets
          </Link>
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-white/60">Connect your wallet to view your bets.</p>
          <div className="flex justify-center">
            <Wallet>
              <ConnectWallet>
                Connect wallet
              </ConnectWallet>
              <WalletDropdown>
                <WalletDropdownDisconnect />
              </WalletDropdown>
            </Wallet>
          </div>
        </div>
      )}
    </main>
  )
}
