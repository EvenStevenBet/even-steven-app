import { NextRequest, NextResponse } from 'next/server'
import { isAddress } from 'viem'
import { fetchPoints } from '@/lib/points'

// GET /api/points?address=0x… → that wallet's points and rank (zeros if it has none yet).
export async function GET(request: NextRequest) {
  const address = request.nextUrl.searchParams.get('address')
  if (!address || !isAddress(address, { strict: false })) {
    return NextResponse.json({ error: 'InvalidRequest', message: 'address must be a valid address' }, { status: 400 })
  }
  const file = await fetchPoints()
  if (!file) return NextResponse.json({ error: 'PointsUnavailable', message: 'points ledger unavailable' }, { status: 503 })

  const key = address.toLowerCase()
  const index = file.addresses.findIndex((r) => r.address === key)
  const row = index === -1 ? { address: key, total: 0, betPoints: 0, referralPoints: 0 } : file.addresses[index]
  return NextResponse.json(
    { ...row, rank: index === -1 ? null : index + 1, updatedAt: file.updatedAt },
    { headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600' } },
  )
}
