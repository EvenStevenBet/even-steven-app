import type { Metadata } from 'next'
import Link from 'next/link'
import { enrichMarket } from '@/lib/markets'
import type { MarketRow } from '@/lib/markets'
import { APP_URL } from '@/lib/chain'
import { BetSlip } from '@/components/BetSlip'

export const revalidate = 60

interface Props {
  params: Promise<{ gameId: string }>
}

async function getMarket(gameId: string) {
  try {
    const res = await fetch(`${APP_URL}/api/markets`, { next: { revalidate: 60 } })
    if (!res.ok) return null
    const data: MarketRow[] = await res.json()
    const row = data.find(m => m.gameId === decodeURIComponent(gameId))
    return row ? enrichMarket(row) : null
  } catch {
    return null
  }
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { gameId } = await params
  const market = await getMarket(gameId)
  if (!market) return { title: 'Market Not Found' }

  const title = `${market.parsedHome} vs ${market.parsedAway}`
  return {
    title,
    description: `Bet on ${market.parsedHome} vs ${market.parsedAway} — ${market.parsedSport} ${market.parsedDate}. No house edge. 2% fee.`,
    openGraph: { title: `${title} · Even Steven` },
  }
}

export default async function MarketPage({ params }: Props) {
  const { gameId } = await params
  const market = await getMarket(gameId)

  if (!market) {
    return (
      <main className="max-w-2xl mx-auto px-4 py-20 text-center space-y-4">
        <p className="font-display text-2xl font-semibold text-white/60">Market not found.</p>
        <Link href="/" className="btn-ghost text-sm">
          ← Back to markets
        </Link>
      </main>
    )
  }

  const fmtDate = (iso: string) =>
    new Date(iso + 'T12:00:00Z').toLocaleDateString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC',
    })

  return (
    <main className="max-w-2xl mx-auto px-4 py-12 space-y-8">

      {/* Breadcrumb */}
      <Link href="/" className="text-xs text-white/40 hover:text-white/70 transition-colors">
        ← Markets
      </Link>

      {/* Matchup header */}
      <header className="space-y-2">
        <span className="inline-block text-[10px] font-display font-semibold tracking-widest uppercase text-gold/60 border border-gold/20 rounded px-1.5 py-0.5">
          {market.parsedSport}
        </span>
        <h1 className="font-display text-4xl sm:text-5xl font-bold leading-tight">
          {market.parsedHome}
          <span className="block text-white/40 text-2xl sm:text-3xl mt-1">vs {market.parsedAway}</span>
        </h1>
        <p className="text-white/50 text-sm tabular">
          {fmtDate(market.parsedDate)}
          {market.gameNumber && ` · Game ${market.gameNumber}`}
        </p>
      </header>

      {market.isLive ? (
        <BetSlip
          marketAddress={market.marketAddress as `0x${string}`}
          homeTeam={market.parsedHome}
          awayTeam={market.parsedAway}
        />
      ) : (
        <div className="ticket p-6 text-center space-y-3">
          <p className="font-display text-xl font-semibold text-white/80">
            Betting opens soon.
          </p>
          {market.bettingOpensAt && (
            <p className="text-sm text-white/40 tabular">
              Opens {new Date(market.bettingOpensAt + 'T12:00:00Z').toLocaleDateString('en-US', {
                month: 'long', day: 'numeric', timeZone: 'UTC',
              })}
            </p>
          )}
        </div>
      )}

    </main>
  )
}
