'use client'

import { useReadContract } from 'wagmi'
import { marketAbi } from '@/lib/contracts'
import { stakedPool } from '@/lib/pool'
import { formatUsdc } from '@/lib/format'

// Page-level ISR caches the market detail page for static content (team
// names, kickoff time), which is exactly why the pool figure can't live in
// that cache too — a bet landing between revalidations would sit invisible
// for up to 60s. This polls independently, same cadence and index layout as
// the getMarketState read in BetSlip.
const POLL_MS = 15_000

interface Props {
  marketAddress: `0x${string}`
}

export function PoolTotal({ marketAddress }: Props) {
  const { data: marketState } = useReadContract({
    address: marketAddress,
    abi: marketAbi,
    functionName: 'getMarketState',
    query: { refetchInterval: (query) => (query.state.data?.[5] === false ? false : POLL_MS) },
  })

  // getMarketState returns (gameId, z, gPool, lePool, tPool, isOpen, isSettled).
  const totalPool: bigint | undefined = marketState?.[4]

  const { data: protocolSeedTotal } = useReadContract({
    address: marketAddress,
    abi: marketAbi,
    functionName: 'protocolSeedTotal',
    query: { staleTime: Infinity },
  })

  const staked =
    totalPool !== undefined && protocolSeedTotal !== undefined
      ? stakedPool(totalPool, protocolSeedTotal)
      : undefined

  return (
    <>
      <p className="mt-1 font-display text-2xl font-bold text-gold tabular">
        {staked === undefined ? '—' : `${formatUsdc(staked)} USDC`}
      </p>
      <p className="mt-0.5 text-xs text-white/40">Total staked by bettors</p>
    </>
  )
}
