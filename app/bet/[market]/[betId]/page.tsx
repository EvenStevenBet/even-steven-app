import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { APP_URL } from '@/lib/chain'
import { formatMultiple, loadBetCard, parseBetParams, type BetCard } from '@/lib/bet-card'
import { formatUsdc } from '@/lib/format'
import { refForSharer } from '@/lib/refs'

export const revalidate = 30

interface Props {
  params: Promise<{ market: string; betId: string }>
}

async function getCard(params: Props['params']) {
  const { market, betId } = await params
  const parsed = parseBetParams(market, betId)
  return parsed ? loadBetCard(parsed.market, parsed.betId) : null
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const card = await getCard(params)
  if (!card) return { title: 'Bet not found' }

  const page = `${APP_URL}/bet/${card.marketAddress}/${card.betId}`
  const image = `${APP_URL}/api/og/bet?market=${card.marketAddress}&betId=${card.betId}`
  const title = `${card.pick} — tail or fade?`
  const description = `${card.lockedLine}. At liquidity, $100 wins $100. 2% fee on your stake, paid upfront.`
  const launch = { name: 'Even Steven', url: page, splashImageUrl: `${APP_URL}/splash.png`, splashBackgroundColor: '#0a0a0a' }
  const embed = (type: string) =>
    JSON.stringify({ version: '1', imageUrl: `${image}&aspect=3:2`, button: { title: 'Tail or fade', action: { type, ...launch } } })

  return {
    title,
    description,
    openGraph: { title, description, url: page, images: [{ url: image, width: 1200, height: 630 }] },
    twitter: { card: 'summary_large_image', title, description, images: [image] },
    other: { 'fc:miniapp': embed('launch_miniapp'), 'fc:frame': embed('launch_frame') },
  }
}

export default async function BetSharePage({ params }: Props) {
  const card = await getCard(params)
  if (!card) notFound()

  const ref = refForSharer(card.bettor)
  const other = card.side === 'home' ? 'away' : 'home'
  const otherTeam = other === 'home' ? card.homeTeam : card.awayTeam
  const marketPath = `/market/${encodeURIComponent(card.gameId)}`
  const link = (side: string) => `${marketPath}?side=${side}&ref=${encodeURIComponent(ref)}`

  return (
    <main className="max-w-xl mx-auto px-4 py-10 space-y-6">
      <p className="text-xs text-white/50 uppercase tracking-widest font-display">
        {card.sport} · {card.homeTeam} vs {card.awayTeam}
      </p>

      <section className="ticket p-5 space-y-4">
        <div className="space-y-1">
          <p className="text-[10px] text-white/40 uppercase tracking-widest font-display">Locked line</p>
          <p className="font-display text-3xl font-bold text-gold tabular">{card.pick}</p>
          <p className="text-sm text-white/85 leading-relaxed">{card.lockedLine}.</p>
          <p className="text-xs text-white/45 tabular">
            Line now: {card.currentLine} · Stake {formatUsdc(card.stake)} USDC
          </p>
        </div>
        <PoolMeter card={card} />
      </section>

      {card.bettingOpen ? (
        <section className="space-y-2">
          <div className="grid grid-cols-2 gap-3">
            <Link href={link(card.side)} className="btn-gold text-center">
              Tail — {card.team}
            </Link>
            <Link href={link(other)} className="btn-ghost text-center">
              Fade — {otherTeam}
            </Link>
          </div>
          <p className="text-[11px] text-white/40 text-center leading-relaxed">
            You get the line as it stands when you bet, not the one locked above.
          </p>
        </section>
      ) : (
        <section className="text-center space-y-2">
          <p className="text-sm text-white/60">Betting is closed for this game.</p>
          <Link href="/" className="btn-ghost text-sm">
            See open markets
          </Link>
        </section>
      )}

      <p className="text-xs text-white/40 text-center leading-relaxed">
        At liquidity, $100 wins $100. Lock your line early. 2% fee on your stake, paid upfront.
      </p>
    </main>
  )
}

function PoolMeter({ card }: { card: BetCard }) {
  const total = card.homeStaked + card.awayStaked
  const homePct = total > BigInt(0) ? Number((card.homeStaked * BigInt(1000)) / total) / 10 : 50
  return (
    <div className="space-y-1.5">
      <div className="flex justify-between gap-2 text-xs text-white/70 tabular">
        <span>{card.homeTeam} ${formatUsdc(card.homeStaked)}</span>
        <span className="text-white/40 uppercase tracking-widest text-[10px] font-display self-center">Pool balance</span>
        <span>${formatUsdc(card.awayStaked)} {card.awayTeam}</span>
      </div>
      <div className="flex h-2.5 w-full rounded-full overflow-hidden bg-white/10" aria-hidden>
        <div className={card.side === 'home' ? 'bg-gold' : 'bg-white/50'} style={{ width: `${homePct}%` }} />
        <div className={['flex-1', card.side === 'away' ? 'bg-gold' : 'bg-white/25'].join(' ')} />
      </div>
      <p className="text-xs text-white/50 tabular">
        {card.multipleX100 === null
          ? `No stakes on ${card.team} yet.`
          : `If ${card.team} covers, at current pools: ${formatMultiple(card.multipleX100)}`}
      </p>
    </div>
  )
}
