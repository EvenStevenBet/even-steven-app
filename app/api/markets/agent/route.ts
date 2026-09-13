import { NextRequest, NextResponse } from 'next/server'
import { serverPublicClient } from '@/lib/server-client'
import { marketAbi, factoryAbi } from '@/lib/contracts'
import { FACTORY_ADDRESS } from '@/lib/chain'
import { formatZDisplay } from '@/lib/format'
import { requirePayment } from '@/lib/x402-server'
import { quoteMarketEV } from '@/lib/payout'

export const dynamic = 'force-dynamic'

const REFERENCE_STAKE = BigInt(100_000_000) // 100 USDC (6 decimals)
const FEE_PERCENT = BigInt(200) // bps — matches SportsbookMarket.FEE_PERCENT (2%)

type EvSide = {
  currentPayout: string
  liquidPayout: string
  impliedVig: string
}

type AgentMarket = {
  marketAddress: `0x${string}`
  gameId: string
  currentZ: string
  currentZDisplay: string
  greaterPool: string
  lessEqualPool: string
  totalPool: string
  isOpen: boolean
  isSettled: boolean
  ev: {
    referenceStake: string
    home: EvSide
    away: EvSide
  }
}

type AgentMarketError = {
  marketAddress: `0x${string}`
  error: string
}

export async function GET(request: NextRequest) {
  const paymentError = await requirePayment(request, '$0.05', 'Live on-chain snapshot of all open markets')
  if (paymentError) return paymentError

  const openMarkets = await serverPublicClient.readContract({
    address: FACTORY_ADDRESS,
    abi: factoryAbi,
    functionName: 'getOpenMarkets',
  })

  const stateContracts = openMarkets.map(
    marketAddress => ({ address: marketAddress, abi: marketAbi, functionName: 'getMarketState' }) as const
  )
  const seedContracts = openMarkets.map(
    marketAddress => ({ address: marketAddress, abi: marketAbi, functionName: 'protocolSeedTotal' }) as const
  )

  const [stateResults, seedResults] = await Promise.all([
    serverPublicClient.multicall({ contracts: stateContracts, allowFailure: true }),
    serverPublicClient.multicall({ contracts: seedContracts, allowFailure: true }),
  ])

  // Computed here rather than via the contract's own getMarketEV: that
  // function's winning-side denominator still includes that side's
  // PROTOCOL_SEED, while real settlement (_sumWinningStakes) never counts the
  // seed as a competing stake — see lib/payout.ts.
  const markets: (AgentMarket | AgentMarketError)[] = openMarkets.map((marketAddress, i) => {
    const stateResult = stateResults[i]
    const seedResult = seedResults[i]

    if (stateResult.status === 'failure') {
      return { marketAddress, error: stateResult.error?.message ?? 'failed to read market state' }
    }
    if (seedResult.status === 'failure') {
      return { marketAddress, error: seedResult.error?.message ?? 'failed to read protocol seed' }
    }

    const [gameId, z, gPool, lePool, tPool, isOpen, isSettled] = stateResult.result
    const protocolSeedTotal = seedResult.result
    const pool = { greaterPool: gPool, lessEqualPool: lePool, totalPool: tPool, protocolSeedTotal }
    const home = quoteMarketEV(pool, REFERENCE_STAKE, true)
    const away = quoteMarketEV(pool, REFERENCE_STAKE, false)

    return {
      marketAddress,
      gameId,
      currentZ: z.toString(),
      currentZDisplay: formatZDisplay(z),
      greaterPool: gPool.toString(),
      lessEqualPool: lePool.toString(),
      totalPool: tPool.toString(),
      isOpen,
      isSettled,
      ev: {
        referenceStake: REFERENCE_STAKE.toString(),
        home: {
          currentPayout: home.currentPayout.toString(),
          liquidPayout: home.liquidPayout.toString(),
          impliedVig: FEE_PERCENT.toString(),
        },
        away: {
          currentPayout: away.currentPayout.toString(),
          liquidPayout: away.liquidPayout.toString(),
          impliedVig: FEE_PERCENT.toString(),
        },
      },
    }
  })

  return NextResponse.json({
    markets,
    relay: {
      note: 'POST /api/bet is not available — agent write betting requires v2 contract (placeBetFor). Coming soon.',
      quoteEndpoint: 'GET /api/bet/quote',
      statusEndpoint: 'GET /api/bet/status',
    },
    timestamp: Date.now(),
  })
}
