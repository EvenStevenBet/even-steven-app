import { NextRequest, NextResponse } from 'next/server'
import { parseUnits, zeroAddress } from 'viem'
import { serverPublicClient } from '@/lib/server-client'
import { marketAbi, factoryAbi } from '@/lib/contracts'
import { FACTORY_ADDRESS } from '@/lib/chain'
import { formatZDisplay } from '@/lib/format'
import { requirePayment } from '@/lib/x402-server'
import { quoteMarketEV } from '@/lib/payout'

export const dynamic = 'force-dynamic'

const FEE_PERCENT = BigInt(200) // bps — matches SportsbookMarket.FEE_PERCENT (2%)
const MIN_STAKE = BigInt(1_000_000) // 1 USDC, 6 decimals

export async function GET(request: NextRequest) {
  const paymentError = await requirePayment(request, '$0.01', 'EV quote for a gameId/side/stake')
  if (paymentError) return paymentError

  const { searchParams } = new URL(request.url)
  const gameId = searchParams.get('gameId')
  const side = searchParams.get('side')
  const stakeParam = searchParams.get('stake')

  if (!gameId || !side || !stakeParam) {
    return NextResponse.json({ error: 'gameId, side, and stake are all required' }, { status: 400 })
  }
  if (side !== 'home' && side !== 'away') {
    return NextResponse.json({ error: 'side must be "home" or "away"' }, { status: 400 })
  }

  let stake: bigint
  try {
    stake = parseUnits(stakeParam, 6)
  } catch {
    return NextResponse.json({ error: 'stake must be a valid decimal USDC amount' }, { status: 400 })
  }
  if (stake < MIN_STAKE) {
    return NextResponse.json({ error: 'stake must be at least 1 USDC' }, { status: 400 })
  }

  const marketAddress = await serverPublicClient.readContract({
    address: FACTORY_ADDRESS,
    abi: factoryAbi,
    functionName: 'marketByGameId',
    args: [gameId],
  })

  if (marketAddress === zeroAddress) {
    return NextResponse.json({ error: `no market found for gameId "${gameId}"` }, { status: 404 })
  }

  const greaterThan = side === 'home'

  const [state, protocolSeedTotal] = await Promise.all([
    serverPublicClient.readContract({
      address: marketAddress,
      abi: marketAbi,
      functionName: 'getMarketState',
    }),
    serverPublicClient.readContract({
      address: marketAddress,
      abi: marketAbi,
      functionName: 'protocolSeedTotal',
    }),
  ])

  const [, currentZ, greaterPool, lessEqualPool, totalPool, isOpen] = state
  if (!isOpen) {
    return NextResponse.json({ error: `market for gameId "${gameId}" is not open for betting` }, { status: 409 })
  }

  // Computed here rather than via an extra getMarketEV RPC call — same
  // formula the v1.10 contract itself uses, reading this market's own
  // protocolSeedTotal rather than assuming a fixed seed. See lib/payout.ts.
  const { currentPayout, liquidPayout } = quoteMarketEV(
    { greaterPool, lessEqualPool, totalPool, protocolSeedTotal },
    stake,
    greaterThan,
  )
  const impliedVig = FEE_PERCENT
  const fee = (stake * FEE_PERCENT) / BigInt(10_000)
  const totalCost = stake + fee

  return NextResponse.json({
    marketAddress,
    gameId,
    side,
    greaterThan,
    stake: stake.toString(),
    fee: fee.toString(),
    totalCost: totalCost.toString(),
    currentZ: currentZ.toString(),
    currentZDisplay: formatZDisplay(currentZ),
    ev: {
      currentPayout: currentPayout.toString(),
      liquidPayout: liquidPayout.toString(),
      impliedVig: impliedVig.toString(),
      netProfitAtLiquidity: (liquidPayout - totalCost).toString(),
    },
    note: 'To place this bet, sign an EIP-3009 ReceiveWithAuthorization for totalCost (to = marketAddress) and POST it to /api/bet.',
  })
}
