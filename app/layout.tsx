import type { Metadata, Viewport } from 'next'
import { Oswald, Inter } from 'next/font/google'
import { Providers } from './providers'
import { Header } from '@/components/Header'
import './globals.css'

const oswald = Oswald({
  subsets: ['latin'],
  variable: '--font-display',
  weight: ['400', '600', '700'],
  display: 'swap',
})

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-body',
  display: 'swap',
})

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'https://evensteven.bet'

export const metadata: Metadata = {
  title: {
    default: 'Even Steven — Bet $100, win $100.',
    template: '%s · Even Steven',
  },
  description:
    'No house. No overround. Winners split 100% of the pool. Parimutuel sports betting on Base. 2% fee.',
  metadataBase: new URL(APP_URL),
  openGraph: {
    type: 'website',
    siteName: 'Even Steven',
    title: 'Even Steven — Bet $100, win $100.',
    description:
      'No house. No overround. Winners split 100% of the pool. 2% fee.',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Even Steven — Bet $100, win $100.',
    description: 'No house. No overround. Winners split 100% of the pool. 2% fee.',
  },
  // favicon: auto-detected from app/icon.tsx — no explicit icons config needed
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#0a0a0a',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" className={`${oswald.variable} ${inter.variable}`}>
      <body className="min-h-dvh bg-bg text-white font-body antialiased">
        <Providers>
          <Header />
          <div className="flex flex-col min-h-[calc(100dvh-3.5rem)]">
            {children}
          </div>
        </Providers>
      </body>
    </html>
  )
}
