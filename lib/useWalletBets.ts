'use client'

import { useEffect, useRef, useState } from 'react'
import type { Address, PublicClient } from 'viem'
import type { ParsedMarket } from '@/lib/markets'
import {
  classifyBets,
  fetchBetLogs,
  fetchClaimedFlags,
  fetchMarketSnapshot,
  type WalletBet,
} from '@/lib/bets'

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
}

/**
 * Scans every live market in `markets` for `address`'s BetPlaced logs, one
 * market at a time, merging results into state as each market resolves rather
 * than waiting on the full set — a wallet with bets on an early market should
 * see them immediately instead of staring at a blank page until the slowest
 * market's log scan finishes.
 */
export function useWalletBets(
  markets: ParsedMarket[],
  address: Address | undefined,
  publicClient: PublicClient | undefined,
): WalletBetsState & { markClaimed: (marketAddress: string, betIds: bigint[]) => void } {
  const [betsByMarket, setBetsByMarket] = useState<Record<string, WalletBet[]>>({})
  const [scannedCount, setScannedCount] = useState(0)
  const generation = useRef(0)

  const marketKey = markets.map(m => m.marketAddress).join(',')

  useEffect(() => {
    if (!address || !publicClient || markets.length === 0) {
      setBetsByMarket({})
      setScannedCount(0)
      return
    }

    generation.current += 1
    const myGeneration = generation.current
    setBetsByMarket({})
    setScannedCount(0)

    let cancelled = false
    const bettor = address

    async function run() {
      const currentBlock = await publicClient!.getBlockNumber()
      const currentSec = Date.now() / 1000

      await Promise.all(
        markets.map(async (market, i) => {
          // Small stagger, not a hard queue: avoids firing every market's first
          // batch of requests in the same instant (the burst that trips a strict
          // public-RPC rate limit hardest), while still letting markets resolve
          // independently and in parallel overall.
          await sleep(i * 150)
          try {
            const marketAddress = market.marketAddress as Address
            const snapshot = await fetchMarketSnapshot(publicClient!, marketAddress)
            const logs = await fetchBetLogs(
              publicClient!,
              marketAddress,
              bettor,
              market.gameDate,
              market.bettingOpensAt,
              currentBlock,
              currentSec
            )
            if (cancelled || generation.current !== myGeneration) return
            if (!snapshot || logs.length === 0) {
              setBetsByMarket(prev => ({ ...prev, [marketAddress]: [] }))
              return
            }

            const claimedFlags = await fetchClaimedFlags(publicClient!, marketAddress, logs.map(l => l.betId))
            if (cancelled || generation.current !== myGeneration) return

            const bets = classifyBets(market, snapshot, logs, claimedFlags)
            setBetsByMarket(prev => ({ ...prev, [marketAddress]: bets }))
          } catch (err) {
            console.error(`[bets] scan failed for ${market.marketAddress}:`, err)
            if (!cancelled && generation.current === myGeneration) {
              setBetsByMarket(prev => ({ ...prev, [market.marketAddress]: [] }))
            }
          } finally {
            if (!cancelled && generation.current === myGeneration) {
              setScannedCount(n => n + 1)
            }
          }
        })
      )
    }

    run()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, publicClient, marketKey])

  const bets = Object.values(betsByMarket).flat()

  return {
    bets,
    loading: scannedCount < markets.length,
    scannedCount,
    totalCount: markets.length,
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
