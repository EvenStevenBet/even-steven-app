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
}

export default nextConfig
