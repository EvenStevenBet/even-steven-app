import { NextRequest, NextResponse } from 'next/server'
import { serverPublicClient } from '@/lib/server-client'
import { marketAbi, factoryAbi } from '@/lib/contracts'
import { FACTORY_ADDRESS } from '@/lib/chain'
import { formatZDisplay } from '@/lib/format'
import { withPayment, type PaidResource } from '@/lib/x402-server'
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

const EV_SIDE_SCHEMA = {
  type: 'object',
  properties: {
    currentPayout: { type: 'string', description: 'Gross payout for referenceStake at the current pools, USDC 6-decimals' },
    liquidPayout: { type: 'string', description: 'Gross payout at liquidity: exactly 2x referenceStake' },
    impliedVig: { type: 'string', description: 'Taker fee on stake in bps, paid upfront (200 = 2%)' },
  },
}

const RESOURCE: PaidResource = {
  description:
    'Live snapshot of every open Even Steven sports market on Base: even-money payouts at liquidity, the early line you lock when you bet, and a flat 2% fee on stake paid upfront.',
  outputSchema: {
    type: 'object',
    properties: {
      markets: {
        type: 'array',
        description: 'Open markets; an entry with only marketAddress + error failed to read',
        items: {
          type: 'object',
          properties: {
            marketAddress: { type: 'string', description: 'Market contract address' },
            gameId: { type: 'string', description: 'SPORT-YYYY-MM-DD-HOME-Team-AWAY-Team' },
            currentZ: { type: 'string', description: 'Current line, 4-decimal fixed point (-35000 = -3.5)' },
            currentZDisplay: { type: 'string', description: 'Current line, human-readable' },
            greaterPool: { type: 'string', description: 'Home-side pool, USDC 6-decimals' },
            lessEqualPool: { type: 'string', description: 'Away-side pool, USDC 6-decimals' },
            totalPool: { type: 'string', description: 'Total pool, USDC 6-decimals' },
            isOpen: { type: 'boolean' },
            isSettled: { type: 'boolean' },
            ev: {
              type: 'object',
              properties: {
                referenceStake: { type: 'string', description: '100 USDC (100000000)' },
                home: EV_SIDE_SCHEMA,
                away: EV_SIDE_SCHEMA,
              },
            },
            error: { type: 'string' },
          },
        },
      },
      relay: { type: 'object', description: 'Pointers to POST /api/bet and the quote/status endpoints' },
      timestamp: { type: 'number', description: 'Unix time in ms' },
    },
  },
}

// Settled only when handle() answers 2xx: a 4xx costs the caller nothing.
export async function GET(request: NextRequest) {
  return withPayment(request, '$0.05', RESOURCE, () => handle(request))
}

async function handle(request: NextRequest) {
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

  // Computed here rather than via an extra getMarketEV RPC call per market —
  // same formula the v1.10 contract itself uses, reading each market's own
  // protocolSeedTotal rather than assuming a fixed seed. See lib/payout.ts.
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
      note: 'Place bets via POST /api/bet — see AGENTS.md for the full relay guide.',
      quoteEndpoint: 'GET /api/bet/quote',
      statusEndpoint: 'GET /api/bet/status',
    },
    timestamp: Date.now(),
  })
}
