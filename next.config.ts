import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  reactStrictMode: true,
  images: {
    // Add external image domains here if needed in the future
    remotePatterns: [],
  },
  // Silence peer-dep warnings from OnchainKit during build
  experimental: {
    optimizePackageImports: ['@coinbase/onchainkit'],
  },
  // Coinbase Smart Wallet's popup handshake needs a permissive COOP policy.
  // FLAG: must be verified in all three surfaces after deploy — standalone
  // (Smart Wallet popup), Base App Mini App (iframe), Farcaster Mini App
  // (iframe) — before this is considered done. If either Mini App breaks,
  // scope this header instead of leaving it broken.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [{ key: 'Cross-Origin-Opener-Policy', value: 'same-origin-allow-popups' }],
      },
    ]
  },
}

export default nextConfig
