import Link from 'next/link'
import { MarketCard } from '@/components/MarketCard'
import { TrustStrip } from '@/components/TrustStrip'
import { enrichMarket, isBettingOpen } from '@/lib/markets'
import type { MarketRow, ParsedMarket } from '@/lib/markets'
import { serverPublicClient } from '@/lib/server-client'
import { marketAbi } from '@/lib/contracts'
import { stakedPool } from '@/lib/pool'

export const revalidate = 60

async function getMarkets() {
  try {
    // Server-side fetch — uses the same revalidation cache as the API route
    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'
    const res = await fetch(`${appUrl}/api/markets`, {
      next: { revalidate: 60 },
    })
    if (!res.ok) throw new Error('markets fetch failed')
    const data: MarketRow[] = await res.json()
    return data.map(enrichMarket)
  } catch {
    return []
  }
}

interface OpenMarket {
  market: ParsedMarket
  currentZ: bigint
  /** Real bettor stakes, seed excluded. */
  staked: bigint
}

// The sheet's status column is editorial and can lag on-chain reality (e.g.
// closeBetting() was called but nobody updated the sheet row). The contract
// itself is the ground truth, so live markets get a final on-chain check before
// being shown. A failed read is treated as closed — never show a bet slip for a
// market we couldn't confirm is open.
//
// getMarketState carries three facts in one call: isOpen for the filter, the
// currentZ the card displays, and totalPool. The seed comes alongside it so the
// card's pool figure counts only real stakes. Homepage line and bet slip line
// come from the same read rather than drifting apart.
async function readOpenOnChain(markets: ParsedMarket[]): Promise<OpenMarket[]> {
  if (markets.length === 0) return []

  try {
    const results = await serverPublicClient.multicall({
      contracts: markets.flatMap(m => {
        const address = m.marketAddress as `0x${string}`
        return [
          { address, abi: marketAbi, functionName: 'getMarketState' },
          { address, abi: marketAbi, functionName: 'protocolSeedTotal' },
        ] as const
      }),
      allowFailure: true,
    })

    const open: OpenMarket[] = []
    markets.forEach((market, i) => {
      const stateResult = results[i * 2]
      const seedResult = results[i * 2 + 1]
      if (stateResult.status !== 'success' || seedResult.status !== 'success') return
      const [, currentZ, , , totalPool, isOpen] = stateResult.result as readonly [
        string, bigint, bigint, bigint, bigint, boolean, boolean,
      ]
      if (!isOpen) return
      open.push({ market, currentZ, staked: stakedPool(totalPool, seedResult.result as bigint) })
    })
    return open
  } catch (err) {
    console.error('[homepage] on-chain market state check failed:', err)
    return []
  }
}

const HIDDEN_UNTIL_UMA_FIX = [
  'NFL-2026-08-22-HOME-Lions-AWAY-Commanders',
  'NFL-2026-08-23-HOME-Titans-AWAY-Seahawks',
]

export default async function HomePage() {
  const allMarkets = await getMarkets()
  const eligible = allMarkets.filter(
    m => m.isLive && isBettingOpen(m) && !HIDDEN_UNTIL_UMA_FIX.includes(m.gameId)
  )
  const markets = await readOpenOnChain(eligible)
  const hasMarkets = markets.length > 0

  return (
    <main className="flex-1">
      {/* ── Hero ─────────────────────────────────────────────────────────── */}
      <section className="max-w-5xl mx-auto px-4 pt-16 pb-12 text-center">
        <h1 className="font-display text-5xl xs:text-6xl sm:text-7xl font-bold leading-none tracking-tight">
          Bet $100,{' '}
          <span className="text-gold">win $100.</span>
        </h1>
        <p className="mt-5 text-lg sm:text-xl text-white/70 max-w-xl mx-auto leading-relaxed">
          No house. No overround. Winners split 100% of the pool.
        </p>
        <p className="mt-2 text-sm text-white/40 tabular">2% fee.</p>

        {/* = motif divider */}
        <div className="eq-divider mt-10 max-w-xs mx-auto" aria-hidden />
      </section>

      {/* ── Market list ──────────────────────────────────────────────────── */}
      <section className="max-w-5xl mx-auto px-4 pb-16">
        {hasMarkets ? (
          <>
            <h2 className="sr-only">Markets</h2>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {markets.map(({ market, currentZ, staked }) => (
                <MarketCard key={market.gameId} market={market} currentZ={currentZ} staked={staked} />
              ))}
            </div>
          </>
        ) : (
          <EmptyState />
        )}
      </section>

      {/* ── Trust strip ──────────────────────────────────────────────────── */}
      <TrustStrip />
    </main>
  )
}

function EmptyState() {
  return (
    <div className="text-center py-20 space-y-6">
      {/* = as visual anchor */}
      <div
        className="font-display text-8xl font-bold text-gold/20 leading-none select-none"
        aria-hidden
      >
        =
      </div>
      <div className="space-y-2">
        <p className="font-display text-xl font-semibold text-white/80">
          NFL preseason markets open soon.
        </p>
        <p className="text-white/40 text-sm max-w-sm mx-auto">
          Contracts deploy before each game. Check back close to kickoff.
        </p>
      </div>
      <Link href="/how-it-works" className="btn-ghost inline-flex text-sm">
        How it works →
      </Link>
    </div>
  )
}
