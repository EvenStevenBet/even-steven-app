'use client'

import { useMiniKit } from '@coinbase/onchainkit/minikit'

// DECISION: 'telegram' is typed now but unimplemented — reserved for future platform support
export type Platform = 'browser' | 'baseApp' | 'farcaster' | 'telegram'

/**
 * Detects which platform the app is running inside.
 * Uses OnchainKit MiniKit context for Base App / Farcaster detection.
 * Returns 'browser' when no mini-app context is present.
 */
export function usePlatformLaunch(): Platform {
  const { context } = useMiniKit()

  if (!context) return 'browser'

  // OnchainKit exposes context.client.platformType for the Mini App host
  // Possible values: 'farcaster' | 'base' | undefined
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const platformType = (context as any)?.client?.platformType as string | undefined

  if (platformType === 'farcaster') return 'farcaster'
  if (platformType === 'base') return 'baseApp'

  // Context exists but platform unknown — still in a mini-app shell
  return 'baseApp'
}
