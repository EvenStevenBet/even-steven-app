import { NextRequest, NextResponse } from 'next/server'
import { isAddress } from 'viem'
import { serverPublicClient } from '@/lib/server-client'
import { marketAbi } from '@/lib/contracts'
import { formatZDisplay } from '@/lib/format'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
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
