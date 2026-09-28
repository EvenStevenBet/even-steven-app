import { NextRequest, NextResponse } from 'next/server'
import { isAddress } from 'viem'
import { serverPublicClient } from '@/lib/server-client'
import { marketAbi } from '@/lib/contracts'
import { formatZDisplay } from '@/lib/format'
import { requirePayment, type PaidResource } from '@/lib/x402-server'

export const dynamic = 'force-dynamic'

const RESOURCE: PaidResource = {
  description:
    "A bettor's Even Steven positions on one market: stakes that pay even money at liquidity, the early line each bet locked, and claim status, with the flat 2% fee on stake already paid upfront.",
  inputSchema: {
    queryParams: {
      marketAddress: 'Market contract address',
      bettor: 'Bettor wallet address',
    },
  },
  outputSchema: {
    type: 'object',
    properties: {
      marketAddress: { type: 'string' },
      bettor: { type: 'string' },
      bets: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            betId: { type: 'string' },
            side: { type: 'string', enum: ['home', 'away'] },
            greaterThan: { type: 'boolean' },
            stake: { type: 'string', description: 'USDC 6-decimals, excluding the upfront fee' },
            lockedZ: { type: 'string', description: 'Line locked at placement, 4-decimal fixed point' },
            lockedZDisplay: { type: 'string' },
            claimed: { type: 'boolean' },
            error: { type: 'string' },
          },
        },
      },
    },
  },
}

export async function GET(request: NextRequest) {
  const paymentError = await requirePayment(request, '$0.01', RESOURCE)
  if (paymentError) return paymentError

  const { searchParams } = new URL(request.url)
  const marketAddressParam = searchParams.get('marketAddress')
  const bettorParam = searchParams.get('bettor')

  if (!marketAddressParam || !isAddress(marketAddressParam)) {
    return NextResponse.json({ error: 'marketAddress is required and must be a valid address' }, { status: 400 })
  }
  if (!bettorParam || !isAddress(bettorParam)) {
    return NextResponse.json({ error: 'bettor is required and must be a valid address' }, { status: 400 })
  }

  const marketAddress = marketAddressParam
  const bettor = bettorParam

  const betIds = await serverPublicClient.readContract({
    address: marketAddress,
    abi: marketAbi,
    functionName: 'getBetsByAddress',
    args: [bettor],
  })

  const betResults = await serverPublicClient.multicall({
    contracts: betIds.map(betId => ({
      address: marketAddress,
      abi: marketAbi,
      functionName: 'getBet' as const,
      args: [betId] as const,
    })),
    allowFailure: true,
  })

  const bets = betIds.map((betId, i) => {
    const result = betResults[i]
    if (result.status === 'failure') {
      return { betId: betId.toString(), error: result.error?.message ?? 'failed to read bet' }
    }
    const bet = result.result
    return {
      betId: betId.toString(),
      side: bet.greaterThan ? 'home' : 'away',
      greaterThan: bet.greaterThan,
      stake: bet.stake.toString(),
      lockedZ: bet.lockedZ.toString(),
      lockedZDisplay: formatZDisplay(bet.lockedZ),
      claimed: bet.claimed,
    }
  })

  return NextResponse.json({
    marketAddress,
    bettor,
    bets,
  })
}
