// app/icon.tsx — Next.js App Router auto-detects this file and adds
// <link rel="icon"> to every page's <head> without any metadata config.
// Override by placing app/favicon.ico if you prefer a static file.
import { ImageResponse } from 'next/og'

export const runtime = 'edge'
export const size = { width: 32, height: 32 }
export const contentType = 'image/png'

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          background: '#0a0a0a',
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 24,
          fontWeight: 900,
          color: '#f5c842',
          fontFamily: 'sans-serif',
          lineHeight: 1,
        }}
      >
        =
      </div>
    ),
    { ...size }
  )
}
