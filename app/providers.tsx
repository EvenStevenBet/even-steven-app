'use client'

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { WagmiProvider } from 'wagmi'
import { OnchainKitProvider } from '@coinbase/onchainkit'
import { MiniKitProvider } from '@coinbase/onchainkit/minikit'
import { wagmiConfig, chain } from '@/lib/wagmi'
import { useState } from 'react'

export function Providers({ children }: { children: React.ReactNode }) {
  // QueryClient is instantiated in state so it's created once per component mount,
  // not recreated on every render, and isolated per request in SSR.
  const [queryClient] = useState(() => new QueryClient({
    defaultOptions: {
      queries: { staleTime: 30_000, refetchOnWindowFocus: false },
    },
  }))

  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <OnchainKitProvider
          apiKey={process.env.NEXT_PUBLIC_ONCHAINKIT_API_KEY}
          chain={chain}
          config={{
            appearance: {
              name: 'Even Steven',
              logo: `${process.env.NEXT_PUBLIC_APP_URL ?? 'https://evensteven.bet'}/icon.png`,
              mode: 'dark',
              theme: 'default',
            },
          }}
        >
          {/* MiniKitProvider enables Base App + Farcaster Mini App context detection */}
          <MiniKitProvider>
            {children}
          </MiniKitProvider>
        </OnchainKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  )
}
