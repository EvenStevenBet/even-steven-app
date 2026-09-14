'use client'

import { useEffect, useRef, useState } from 'react'
import type { Address, PublicClient } from 'viem'
import type { ParsedMarket } from '@/lib/markets'
import { classifyBets, fetchMarketSnapshot, fetchWalletBets, type WalletBet } from '@/lib/bets'

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export interface WalletBetsState {
  /** All bets found so far, across every market that has finished scanning. */
  bets: WalletBet[]
  /** True while at least one market is still being scanned. Sections render incrementally regardless. */
  loading: boolean
  scannedCount: number
  totalCount: number
  /** Markets whose scan failed after the retry budget in lib/bets.ts was exhausted — surfaced distinctly from "no bets found." */
  errors: { market: ParsedMarket; message: string }[]
}

/**
 * Scans every live market in `markets` for `address`'s bets via
 * getBetsByAddress()/getBet() (see lib/bets.ts — no block-range log scanning),
 * one market at a time, merging results into state as each market resolves
 * rather than waiting on the full set.
 */
export function useWalletBets(
  markets: ParsedMarket[],
  address: Address | undefined,
  publicClient: PublicClient | undefined,
): WalletBetsState & { markClaimed: (marketAddress: string, betIds: bigint[]) => void } {
  const [betsByMarket, setBetsByMarket] = useState<Record<string, WalletBet[]>>({})
  const [errorsByMarket, setErrorsByMarket] = useState<Record<string, string>>({})
  const [scannedCount, setScannedCount] = useState(0)
  const generation = useRef(0)

  const marketKey = markets.map(m => m.marketAddress).join(',')

  useEffect(() => {
    if (!address || !publicClient || markets.length === 0) {
      setBetsByMarket({})
      setErrorsByMarket({})
      setScannedCount(0)
      return
    }

    generation.current += 1
    const myGeneration = generation.current
    setBetsByMarket({})
    setErrorsByMarket({})
    setScannedCount(0)

    let cancelled = false
    const bettor = address
    const client = publicClient

    markets.forEach(async (market, i) => {
      // Small stagger, not a hard queue: avoids firing every market's first
      // request in the same instant, while still letting markets resolve
      // independently and in parallel overall.
      await sleep(i * 150)
      if (cancelled || generation.current !== myGeneration) return

      try {
        const marketAddress = market.marketAddress as Address
        const snapshot = await fetchMarketSnapshot(client, marketAddress)
        if (cancelled || generation.current !== myGeneration) return

        const rawBets = await fetchWalletBets(client, marketAddress, bettor)
        if (cancelled || generation.current !== myGeneration) return

        const bets = classifyBets(market, snapshot, rawBets)
        setBetsByMarket(prev => ({ ...prev, [marketAddress]: bets }))
      } catch (err) {
        // lib/bets.ts already retried with backoff and logged the underlying
        // error before rethrowing — this is the final, exhausted failure.
        // Surface it distinctly rather than treating it as "no bets on this
        // market," which would silently hide a wallet's real bets on an RPC hiccup.
        const message = err instanceof Error ? err.message : 'Failed to load this market.'
        if (!cancelled && generation.current === myGeneration) {
          setErrorsByMarket(prev => ({ ...prev, [market.marketAddress]: message }))
        }
      } finally {
        if (!cancelled && generation.current === myGeneration) {
          setScannedCount(n => n + 1)
        }
      }
    })

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, publicClient, marketKey])

  const bets = Object.values(betsByMarket).flat()
  const errors = markets
    .filter(m => errorsByMarket[m.marketAddress])
    .map(m => ({ market: m, message: errorsByMarket[m.marketAddress] }))

  return {
    bets,
    loading: scannedCount < markets.length,
    scannedCount,
    totalCount: markets.length,
    errors,
    // Flips claimed bets to their resolved History status locally — no rescan
    // needed, since the payout figure was already computed correctly from
    // final settlement state at scan time and claiming doesn't change it.
    markClaimed: (marketAddress: string, betIds: bigint[]) => {
      const idSet = new Set(betIds.map(String))
      setBetsByMarket(prev => {
        const current = prev[marketAddress]
        if (!current) return prev
        return {
          ...prev,
          [marketAddress]: current.map(bet =>
            idSet.has(bet.betId.toString()) && bet.outcome
              ? { ...bet, claimed: true, status: bet.outcome }
              : bet
          ),
        }
      })
    },
  }
}
