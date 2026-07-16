import Link from 'next/link'
import { MarketCard } from '@/components/MarketCard'
import { TrustStrip } from '@/components/TrustStrip'
import { enrichMarket } from '@/lib/markets'
import type { MarketRow } from '@/lib/markets'

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

export default async function HomePage() {
  const markets = await getMarkets()
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
              {markets.map(m => (
                <MarketCard key={m.gameId} market={m} />
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
