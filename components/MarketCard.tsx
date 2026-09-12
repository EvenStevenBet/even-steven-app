import Link from 'next/link'
import type { ParsedMarket } from '@/lib/markets'
import { favoriteQuote } from '@/lib/line'
import { formatMarketDate } from '@/lib/format'
import { isFirstMoverMarket } from '@/lib/pool'
import { FirstMoverBadge } from '@/components/FirstMoverBadge'

interface Props {
  market: ParsedMarket
  /**
   * Live currentZ read from getMarketState — the same source the bet slip uses.
   * undefined when the read failed or the market isn't on chain yet.
   */
  currentZ?: bigint
  /** Real bettor stakes, seed excluded — drives the first-mover badge. */
  staked?: bigint
}

export function MarketCard({ market, currentZ, staked }: Props) {
  if (market.isLive) {
    return <LiveCard market={market} currentZ={currentZ} staked={staked} />
  }
  return <ComingSoonCard market={market} />
}

function LiveCard({ market, currentZ, staked }: Props) {
  return (
    <Link
      href={`/market/${encodeURIComponent(market.gameId)}`}
      className="ticket group block p-5 hover:border-gold/40 transition-colors cursor-pointer"
    >
      <SportTag sport={market.parsedSport} />

      <div className="mt-3 flex items-start justify-between gap-3">
        <Matchup home={market.parsedHome} away={market.parsedAway} />
        <CurrentLine market={market} currentZ={currentZ} />
      </div>

      {isFirstMoverMarket(staked) && (
        <div className="mt-3">
          <FirstMoverBadge className="text-[10px] px-2" />
        </div>
      )}

      <div className="mt-4 flex items-center justify-between text-xs text-white/40">
        <GameDate market={market} />
        <span className="text-gold/80 font-display font-semibold uppercase tracking-wider group-hover:text-gold transition-colors">
          Bet →
        </span>
      </div>
    </Link>
  )
}

/**
 * The line, attached to the team it belongs to — same format as the bet slip,
 * from the same currentZ. A bare dash here contradicts the line the user sees
 * one click later, so an unread line says so in words instead.
 */
function CurrentLine({ market, currentZ }: Props) {
  if (currentZ === undefined) {
    return (
      <div className="shrink-0 text-right max-w-[7.5rem]">
        <span className="font-display text-xs font-semibold text-white/50 leading-tight block">
          Line set at open
        </span>
      </div>
    )
  }

  const { team, spread } = favoriteQuote(currentZ, market.parsedHome, market.parsedAway)

  return (
    <div className="shrink-0 text-right max-w-[7.5rem]">
      {team !== null && (
        <p className="font-display text-[11px] font-semibold uppercase tracking-wide text-white/60 leading-tight break-words">
          {team}
        </p>
      )}
      <span className="tabular font-display text-lg font-semibold text-gold leading-tight block">
        {spread}
      </span>
      <p className="text-xs text-white/40 mt-0.5">current line</p>
    </div>
  )
}

function ComingSoonCard({ market }: Props) {
  const opens = formatMarketDate(market.bettingOpensAt, {
    weekday: 'short', month: 'short', day: 'numeric',
  })
  const opensLabel = opens ? `Betting opens ${opens}` : 'Betting opens soon'

  return (
    <div className="ticket p-5 opacity-70 select-none">
      <SportTag sport={market.parsedSport} />

      <div className="mt-3">
        <Matchup home={market.parsedHome} away={market.parsedAway} />
      </div>

      <div className="mt-4 flex items-center justify-between gap-2 text-xs text-white/40">
        <GameDate market={market} />
        <span className="text-white/40 font-display uppercase tracking-wider text-right">{opensLabel}</span>
      </div>
    </div>
  )
}

function GameDate({ market }: { market: ParsedMarket }) {
  const label = formatMarketDate(market.gameDate || market.parsedDate, {
    weekday: 'short', month: 'short', day: 'numeric',
  })
  if (!label) return <span />
  return <time dateTime={market.parsedDate}>{label}</time>
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
    <div className="space-y-0.5 min-w-0">
      <p className="font-display text-base font-semibold leading-tight break-words">{home}</p>
      <div className="eq-divider text-[10px]">vs</div>
      <p className="font-display text-base font-semibold leading-tight text-white/70 break-words">{away}</p>
    </div>
  )
}
