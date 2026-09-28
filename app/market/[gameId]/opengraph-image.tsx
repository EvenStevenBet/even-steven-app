import { ImageResponse } from 'next/og'
import type { MarketRow } from '@/lib/markets'
import { enrichMarket } from '@/lib/markets'
import { APP_URL } from '@/lib/chain'
import { serverPublicClient } from '@/lib/server-client'
import { marketAbi } from '@/lib/contracts'
import { favoriteHeadline } from '@/lib/line'

export const revalidate = 60
export const alt = 'Even Steven market'
export const size = { width: 1200, height: 630 }
export const contentType = 'image/png'

interface Props {
  params: Promise<{ gameId: string }>
}

async function fetchMarket(gameId: string) {
  try {
    const res = await fetch(`${APP_URL}/api/markets`)
    if (!res.ok) return null
    const data: MarketRow[] = await res.json()
    const row = data.find(m => m.gameId === decodeURIComponent(gameId))
    return row ? enrichMarket(row) : null
  } catch {
    return null
  }
}

export default async function MarketOgImage({ params }: Props) {
  const { gameId } = await params
  const market = await fetchMarket(gameId)

  const home  = market?.parsedHome  ?? 'Home'
  const away  = market?.parsedAway  ?? 'Away'
  const sport = market?.parsedSport ?? 'Game'
  // The live line from chain; the CSV openLine column is empty for bot-opened markets.
  let line = ''
  if (market?.marketAddress) {
    try {
      const state = await serverPublicClient.readContract({
        address: market.marketAddress as `0x${string}`, abi: marketAbi, functionName: 'getMarketState',
      })
      line = favoriteHeadline(state[1], home, away)
    } catch {
      // Unreadable market: render the matchup without a line rather than fail the image.
    }
  }

  return new ImageResponse(
    (
      <div
        style={{
          background: '#0a0a0a',
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          padding: '56px 72px',
          fontFamily: 'sans-serif',
          position: 'relative',
        }}
      >
        {/* Gold top border */}
        <div
          style={{
            position: 'absolute',
            top: 0, left: 0, right: 0,
            height: '6px',
            background: '#f5c842',
          }}
        />

        {/* Sport tag */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 16,
          }}
        >
          <div
            style={{
              fontSize: 14,
              fontWeight: 700,
              color: '#f5c842',
              letterSpacing: '4px',
              textTransform: 'uppercase',
              border: '1px solid rgba(245,200,66,0.3)',
              padding: '4px 10px',
              borderRadius: 4,
            }}
          >
            {sport}
          </div>
          {line && (
            <div
              style={{
                fontSize: 14,
                color: 'rgba(255,255,255,0.4)',
                letterSpacing: '2px',
              }}
            >
              {line}
            </div>
          )}
        </div>

        {/* Matchup */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ fontSize: 72, fontWeight: 800, color: '#ffffff', lineHeight: 1 }}>
            {home}
          </div>
          <div style={{ fontSize: 28, color: 'rgba(255,255,255,0.35)', letterSpacing: '4px', textTransform: 'uppercase' }}>
            vs
          </div>
          <div style={{ fontSize: 72, fontWeight: 800, color: 'rgba(255,255,255,0.55)', lineHeight: 1 }}>
            {away}
          </div>
        </div>

        {/* Footer */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end' }}>
          <div
            style={{
              fontSize: 32,
              fontWeight: 700,
              color: '#f5c842',
            }}
          >
            Bet $100, win $100.
          </div>
          <div
            style={{
              fontSize: 16,
              color: 'rgba(255,255,255,0.3)',
              letterSpacing: '2px',
              textTransform: 'uppercase',
            }}
          >
            evensteven.bet
          </div>
        </div>
      </div>
    ),
    { ...size }
  )
}
