import { ImageResponse } from 'next/og'

export const runtime = 'edge'
export const alt = 'Even Steven — Bet $100, win $100.'
export const size = { width: 1200, height: 630 }
export const contentType = 'image/png'

export default function OgImage() {
  return new ImageResponse(
    (
      <div
        style={{
          background: '#0a0a0a',
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '80px',
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

        {/* = motif */}
        <div
          style={{
            fontSize: 120,
            fontWeight: 900,
            color: '#f5c842',
            lineHeight: 1,
            marginBottom: 32,
            opacity: 0.9,
          }}
        >
          =
        </div>

        {/* Headline */}
        <div
          style={{
            fontSize: 72,
            fontWeight: 800,
            color: '#ffffff',
            textAlign: 'center',
            lineHeight: 1.1,
            letterSpacing: '-2px',
          }}
        >
          Bet $100, win $100.
        </div>

        {/* Sub */}
        <div
          style={{
            fontSize: 32,
            color: 'rgba(255,255,255,0.55)',
            marginTop: 24,
            textAlign: 'center',
          }}
        >
          No house. No overround. Winners split 100% of the pool.
        </div>

        {/* Wordmark */}
        <div
          style={{
            position: 'absolute',
            bottom: 48,
            display: 'flex',
            alignItems: 'center',
            gap: 12,
          }}
        >
          <div
            style={{
              fontSize: 20,
              fontWeight: 700,
              color: '#f5c842',
              letterSpacing: '4px',
              textTransform: 'uppercase',
            }}
          >
            EVEN STEVEN
          </div>
          <div style={{ color: 'rgba(255,255,255,0.2)', fontSize: 16 }}>·</div>
          <div style={{ color: 'rgba(255,255,255,0.35)', fontSize: 16 }}>
            evensteven.bet
          </div>
        </div>
      </div>
    ),
    { ...size }
  )
}
