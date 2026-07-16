'use client'

import Link from 'next/link'
import Image from 'next/image'
import { usePathname } from 'next/navigation'
import { useState } from 'react'
import {
  ConnectWallet,
  Wallet,
  WalletDropdown,
  WalletDropdownDisconnect,
} from '@coinbase/onchainkit/wallet'
import {
  Address,
  Avatar,
  Name,
  Identity,
} from '@coinbase/onchainkit/identity'

const NAV = [
  { href: '/',             label: 'Markets' },
  { href: '/bets',         label: 'My Bets' },
  { href: '/how-it-works', label: 'How It Works' },
]

export function Header() {
  const pathname = usePathname()
  const [menuOpen, setMenuOpen] = useState(false)

  return (
    <header className="sticky top-0 z-50 border-b border-white/8 bg-bg/90 backdrop-blur-sm">
      <div className="max-w-5xl mx-auto px-4 h-14 flex items-center justify-between gap-4">

        {/* Logo */}
        <Link
          href="/"
          className="flex items-center gap-2.5 shrink-0 focus-visible:rounded-sm"
        >
          <Image
            src="/evenstevenlogogold.png"
            alt=""
            width={30}
            height={30}
            className="rounded-full"
            priority
          />
          <span className="font-display text-base font-semibold text-gold tracking-widest uppercase">
            Even Steven
          </span>
        </Link>

        {/* Desktop nav */}
        <nav className="hidden sm:flex items-center gap-1 text-sm">
          {NAV.map(({ href, label }) => (
            <Link
              key={href}
              href={href}
              className={[
                'px-3 py-1.5 rounded-md transition-colors',
                pathname === href
                  ? 'text-white bg-white/8'
                  : 'text-white/60 hover:text-white hover:bg-white/5',
              ].join(' ')}
            >
              {label}
            </Link>
          ))}
        </nav>

        <div className="flex items-center gap-2">
          {/* Wallet — OnchainKit handles Smart Wallet + EOA + WalletConnect */}
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

          {/* Mobile hamburger */}
          <button
            onClick={() => setMenuOpen(o => !o)}
            className="sm:hidden p-2 text-white/60 hover:text-white rounded-md transition-colors"
            aria-label={menuOpen ? 'Close menu' : 'Open menu'}
            aria-expanded={menuOpen}
          >
            <span className="block w-5 text-gold font-display font-bold leading-none select-none">
              {menuOpen ? '×' : '='}
            </span>
          </button>
        </div>
      </div>

      {/* Mobile dropdown */}
      {menuOpen && (
        <nav className="sm:hidden border-t border-white/8 bg-bg px-4 py-3 flex flex-col gap-1">
          {NAV.map(({ href, label }) => (
            <Link
              key={href}
              href={href}
              onClick={() => setMenuOpen(false)}
              className={[
                'px-3 py-2.5 rounded-md text-sm transition-colors',
                pathname === href
                  ? 'text-white bg-white/8'
                  : 'text-white/70 hover:text-white hover:bg-white/5',
              ].join(' ')}
            >
              {label}
            </Link>
          ))}
        </nav>
      )}
    </header>
  )
}
