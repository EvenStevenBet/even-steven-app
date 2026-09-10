import { NextRequest, NextResponse } from 'next/server'
import { serverPublicClient } from '@/lib/server-client'
import { marketAbi, factoryAbi } from '@/lib/contracts'
import { FACTORY_ADDRESS } from '@/lib/chain'
import { formatZDisplay } from '@/lib/format'
import { requirePayment } from '@/lib/x402-server'

export const dynamic = 'force-dynamic'

const REFERENCE_STAKE = BigInt(100_000_000) // 100 USDC (6 decimals)

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
  const homeEvContracts = openMarkets.map(
    marketAddress =>
      ({ address: marketAddress, abi: marketAbi, functionName: 'getMarketEV', args: [REFERENCE_STAKE, true] }) as const
  )
  const awayEvContracts = openMarkets.map(
    marketAddress =>
      ({ address: marketAddress, abi: marketAbi, functionName: 'getMarketEV', args: [REFERENCE_STAKE, false] }) as const
  )

  const [stateResults, homeEvResults, awayEvResults] = await Promise.all([
    serverPublicClient.multicall({ contracts: stateContracts, allowFailure: true }),
    serverPublicClient.multicall({ contracts: homeEvContracts, allowFailure: true }),
    serverPublicClient.multicall({ contracts: awayEvContracts, allowFailure: true }),
  ])

  const markets: (AgentMarket | AgentMarketError)[] = openMarkets.map((marketAddress, i) => {
    const stateResult = stateResults[i]
    const homeEvResult = homeEvResults[i]
    const awayEvResult = awayEvResults[i]

    if (stateResult.status === 'failure') {
      return { marketAddress, error: stateResult.error?.message ?? 'failed to read market state' }
    }
    if (homeEvResult.status === 'failure' || awayEvResult.status === 'failure') {
      const failed = homeEvResult.status === 'failure' ? homeEvResult : awayEvResult
      return { marketAddress, error: failed.error?.message ?? 'failed to read market EV' }
    }

    const [gameId, z, gPool, lePool, tPool, isOpen, isSettled] = stateResult.result
    const [homeCurrentPayout, homeLiquidPayout, homeImpliedVig] = homeEvResult.result
    const [awayCurrentPayout, awayLiquidPayout, awayImpliedVig] = awayEvResult.result

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
          currentPayout: homeCurrentPayout.toString(),
          liquidPayout: homeLiquidPayout.toString(),
          impliedVig: homeImpliedVig.toString(),
        },
        away: {
          currentPayout: awayCurrentPayout.toString(),
          liquidPayout: awayLiquidPayout.toString(),
          impliedVig: awayImpliedVig.toString(),
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
