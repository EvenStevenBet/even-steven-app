import type { Metadata } from 'next'
import Link from 'next/link'
import { enrichMarket } from '@/lib/markets'
import type { MarketRow } from '@/lib/markets'
import { APP_URL } from '@/lib/chain'
import { BetSlip } from '@/components/BetSlip'
import { serverPublicClient } from '@/lib/server-client'
import { marketAbi } from '@/lib/contracts'
import { formatMarketDate, formatUsdc } from '@/lib/format'

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

/**
 * Stakes actually wagered, excluding the protocol seed. totalPool includes the
 * 2 USDC seed (1 per side) that counts toward the odds denominator but is never
 * distributable — showing it would make an untouched market look like it holds $2.
 */
async function getStakedPool(marketAddress: `0x${string}`): Promise<bigint | null> {
  try {
    const [state, seed] = await serverPublicClient.multicall({
      contracts: [
        { address: marketAddress, abi: marketAbi, functionName: 'getMarketState' },
        { address: marketAddress, abi: marketAbi, functionName: 'protocolSeedTotal' },
      ],
      allowFailure: false,
    })
    const totalPool = state[4]
    return totalPool > seed ? totalPool - seed : BigInt(0)
  } catch (err) {
    console.error('[market] pool read failed:', err)
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

  const stakedPool = market.isLive ? await getStakedPool(market.marketAddress as `0x${string}`) : null

  const kickoff = formatMarketDate(market.gameDate || market.parsedDate, {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
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
          {kickoff}
          {market.gameNumber && ` · Game ${market.gameNumber}`}
        </p>
      </header>

      {/* Above the fold, above the slip: how real is this market, and when do
          payouts land. "2.00× on a $6 pool" and "2.00× on a $60,000 pool" look
          identical in the payout figures and are very different propositions. */}
      {market.isLive && (
        <section className="grid gap-3 sm:grid-cols-2">
          <div className="ticket p-4">
            <p className="text-[10px] text-white/40 uppercase tracking-widest font-display">In this market</p>
            <p className="mt-1 font-display text-2xl font-bold text-gold tabular">
              {stakedPool === null ? '—' : `${formatUsdc(stakedPool)} USDC`}
            </p>
            <p className="mt-0.5 text-xs text-white/40">Total staked by bettors</p>
          </div>
          <div className="ticket p-4">
            <p className="text-[10px] text-white/40 uppercase tracking-widest font-display">Settlement</p>
            <p className="mt-1 text-sm text-white/80 leading-snug">
              Payouts available ~2 hours after the game ends.
            </p>
            <p className="mt-0.5 text-xs text-white/40">
              The result is asserted to UMA&apos;s oracle, which has a 2-hour challenge window.
            </p>
          </div>
        </section>
      )}

      {market.isLive ? (
        <BetSlip
          marketAddress={market.marketAddress as `0x${string}`}
          homeTeam={market.parsedHome}
          awayTeam={market.parsedAway}
          closesAt={market.gameDate}
        />
      ) : (
        <div className="ticket p-6 text-center space-y-3">
          <p className="font-display text-xl font-semibold text-white/80">
            Betting opens soon.
          </p>
          {formatMarketDate(market.bettingOpensAt, { month: 'long', day: 'numeric' }) && (
            <p className="text-sm text-white/40 tabular">
              Opens {formatMarketDate(market.bettingOpensAt, { month: 'long', day: 'numeric' })}
            </p>
          )}
        </div>
      )}

    </main>
  )
}
