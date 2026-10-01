import { ImageResponse } from 'next/og'
import type { NextRequest } from 'next/server'
import { formatMultiple, loadBetCard, parseBetParams } from '@/lib/bet-card'
import { formatUsdc } from '@/lib/format'

// /api/og/bet?market=<addr>&betId=<id>[&aspect=3:2]
// 1200×630 for X / Open Graph; 3:2 (1200×800) for the Farcaster fc:miniapp embed.
// X overlays its title label on the bottom-left of summary_large_image cards, so the bottom
// SAFE_BOTTOM px stay empty except for the right-anchored footer.
const SAFE_BOTTOM = 120

const GOLD = '#f5c842'
const BG = '#0a0a0a'

export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams
  const params = parseBetParams(q.get('market') ?? '', q.get('betId') ?? '')
  const card = params ? await loadBetCard(params.market, params.betId) : null
  const tall = q.get('aspect') === '3:2'
  const size = { width: 1200, height: tall ? 800 : 630 }
  const headers = { 'Cache-Control': 'public, max-age=60, s-maxage=60, stale-while-revalidate=300' }

  if (!card) {
    return new ImageResponse(
      (
        <div style={{ background: BG, width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: GOLD, fontSize: 64, fontWeight: 800 }}>
          EVEN STEVEN
        </div>
      ),
      { ...size, headers },
    )
  }

  const total = card.homeStaked + card.awayStaked
  // Home share of the pool; an empty pool draws as even.
  const homePct = total > BigInt(0) ? Number((card.homeStaked * BigInt(1000)) / total) / 10 : 50

  return new ImageResponse(
    (
      <div style={{ background: BG, width: '100%', height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', padding: `${tall ? 64 : 44}px 72px ${SAFE_BOTTOM}px`, color: '#fff', fontFamily: 'sans-serif', position: 'relative' }}>
        <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 6, background: GOLD }} />

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ display: 'flex', fontSize: 22, color: 'rgba(255,255,255,0.55)', letterSpacing: 2 }}>
            {`${card.sport} · ${card.homeTeam.toUpperCase()} VS ${card.awayTeam.toUpperCase()}`}
          </div>
          <div style={{ display: 'flex', fontSize: 22, fontWeight: 700, color: GOLD, letterSpacing: 4 }}>EVEN STEVEN</div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', fontSize: 20, color: 'rgba(255,255,255,0.45)', letterSpacing: 3 }}>LOCKED LINE</div>
          <div style={{ display: 'flex', fontSize: tall ? 92 : 80, fontWeight: 800, color: GOLD, lineHeight: 1 }}>{card.pick}</div>
          <div style={{ display: 'flex', fontSize: 30, color: 'rgba(255,255,255,0.85)' }}>{`${card.lockedLine}.`}</div>
          <div style={{ display: 'flex', fontSize: 22, color: 'rgba(255,255,255,0.45)', marginTop: 4 }}>
            {`Line now: ${card.currentLine} · Stake ${formatUsdc(card.stake)} USDC`}
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', fontSize: 22, color: 'rgba(255,255,255,0.6)' }}>
            {card.multipleX100 === null
              ? `No stakes on ${card.team} yet`
              : `If ${card.team} covers, at current pools: ${formatMultiple(card.multipleX100)}`}
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 22, color: 'rgba(255,255,255,0.7)' }}>
            <div style={{ display: 'flex' }}>{`${card.homeTeam} $${formatUsdc(card.homeStaked)}`}</div>
            <div style={{ display: 'flex', color: 'rgba(255,255,255,0.45)' }}>POOL BALANCE</div>
            <div style={{ display: 'flex' }}>{`$${formatUsdc(card.awayStaked)} ${card.awayTeam}`}</div>
          </div>
          <div style={{ display: 'flex', height: 22, width: '100%', borderRadius: 11, overflow: 'hidden', background: 'rgba(255,255,255,0.12)' }}>
            <div style={{ display: 'flex', width: `${homePct}%`, height: '100%', background: card.side === 'home' ? GOLD : 'rgba(255,255,255,0.55)' }} />
            <div style={{ display: 'flex', flexGrow: 1, height: '100%', background: card.side === 'away' ? GOLD : 'rgba(255,255,255,0.3)' }} />
          </div>
        </div>

        <div style={{ position: 'absolute', right: 72, bottom: 44, display: 'flex', fontSize: 20, color: 'rgba(255,255,255,0.4)' }}>
          At liquidity, $100 wins $100 · 2% fee
        </div>
      </div>
    ),
    { ...size, headers },
  )
}
