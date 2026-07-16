import Link from 'next/link'
import type { ParsedMarket } from '@/lib/markets'

interface Props {
  market: ParsedMarket
}

// Format "2026-09-06" → "Sat Sep 6"
function fmtDate(iso: string): string {
  const d = new Date(iso + 'T12:00:00Z')
  return d.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  })
}

export function MarketCard({ market }: Props) {
  if (market.isLive) {
    return <LiveCard market={market} />
  }
  return <ComingSoonCard market={market} />
}

function LiveCard({ market }: Props) {
  return (
    <Link
      href={`/market/${encodeURIComponent(market.gameId)}`}
      className="ticket group block p-5 hover:border-gold/40 transition-colors cursor-pointer"
    >
      <SportTag sport={market.parsedSport} />

      <div className="mt-3 flex items-center justify-between gap-2">
        <Matchup home={market.parsedHome} away={market.parsedAway} />
        {/* Line shown only on live cards — chain data hydrated client-side in Stage 2 */}
        <div className="shrink-0 text-right">
          <span className="tabular font-display text-lg font-semibold text-gold">
            {market.openLine || '—'}
          </span>
          <p className="text-xs text-white/40 mt-0.5">opening line</p>
        </div>
      </div>

      <div className="mt-4 flex items-center justify-between text-xs text-white/40">
        <time dateTime={market.parsedDate}>{fmtDate(market.parsedDate)}</time>
        <span className="text-gold/80 font-display font-semibold uppercase tracking-wider group-hover:text-gold transition-colors">
          Bet →
        </span>
      </div>
    </Link>
  )
}

function ComingSoonCard({ market }: Props) {
  const opensLabel = market.bettingOpensAt
    ? `Betting opens ${fmtDate(market.bettingOpensAt)}`
    : 'Betting opens soon'

  return (
    <div className="ticket p-5 opacity-70 select-none">
      <SportTag sport={market.parsedSport} />

      <div className="mt-3">
        <Matchup home={market.parsedHome} away={market.parsedAway} />
      </div>

      <div className="mt-4 flex items-center justify-between text-xs text-white/40">
        <time dateTime={market.parsedDate}>{fmtDate(market.parsedDate)}</time>
        <span className="text-white/40 font-display uppercase tracking-wider">{opensLabel}</span>
      </div>
    </div>
  )
}

function SportTag({ sport }: { sport: string }) {
  return (
    <span className="inline-block text-[10px] font-display font-semibold tracking-widest uppercase text-gold/60 border border-gold/20 rounded px-1.5 py-0.5">
      {sport}
    </span>
  )
}

function Matchup({ home, away }: { home: string; away: string }) {
  return (
    <div className="space-y-0.5">
      <p className="font-display text-base font-semibold leading-tight">{home}</p>
      <div className="eq-divider text-[10px]">vs</div>
      <p className="font-display text-base font-semibold leading-tight text-white/70">{away}</p>
    </div>
  )
}
