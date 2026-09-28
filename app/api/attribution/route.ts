import { NextRequest, NextResponse } from 'next/server'
import { parseEventLogs, type Address, type Hash } from 'viem'
import { serverPublicClient } from '@/lib/server-client'
import { factoryAbi, marketAbi } from '@/lib/contracts'
import { clientIp } from '@/lib/abuse'
import { refsFromCalldata } from '@/lib/attribution'
import { buildRecord, consumeAttributionRateLimit, hasAttribution, recordAttribution } from '@/lib/attribution-store'
import { resolveRefForBettor, type ResolvedRef } from '@/lib/refs'

export const dynamic = 'force-dynamic'

const V1_6_FACTORY: Address = '0x5906370b9831728ec523b647137a1bbf0ab45390'
const RELAY: Address = '0x8a3eee4f6aD1c03Dc3d898ecD61283560Bd42fed'
const TX_HASH = /^0x[0-9a-fA-F]{64}$/

function fail(status: number, error: string, message: string) {
  return NextResponse.json({ recorded: false, error, message }, { status })
}

// Records a confirmed web bet. The body carries only the txHash: the ref is read from the
// ERC-8021 suffix in the transaction's own calldata, which the bettor signed, so posting
// someone else's txHash can't attach a ref to their bet.
export async function POST(request: NextRequest) {
  try {
    return await handle(request)
  } catch (err) {
    console.error('[api/attribution] unhandled error', err)
    return fail(500, 'InternalError', 'unexpected server error')
  }
}

async function handle(request: NextRequest) {
  try {
    if (await consumeAttributionRateLimit(clientIp(request))) {
      return fail(429, 'RateLimited', 'too many attribution requests from this IP')
    }
  } catch (err) {
    console.error('[api/attribution] store unavailable', err)
    return fail(503, 'StoreUnavailable', 'attribution store is unavailable')
  }

  let txHash: Hash
  try {
    const body = await request.json()
    if (typeof body?.txHash !== 'string' || !TX_HASH.test(body.txHash)) throw new Error()
    txHash = body.txHash.toLowerCase() as Hash
  } catch {
    return fail(400, 'InvalidRequest', 'body must be { "txHash": "0x…" }')
  }

  if (await hasAttribution(txHash)) {
    return NextResponse.json({ recorded: false, reason: 'AlreadyRecorded' })
  }

  let receipt
  try {
    receipt = await serverPublicClient.getTransactionReceipt({ hash: txHash })
  } catch {
    return fail(404, 'TxNotFound', 'no mined transaction with this hash yet; retry shortly')
  }
  if (receipt.status !== 'success') return fail(400, 'TxReverted', 'transaction reverted')

  const placed = parseEventLogs({ abi: marketAbi, eventName: 'BetPlaced', logs: receipt.logs })
  const markets = [...new Set(placed.map((e) => e.address.toLowerCase() as Address))]
  const v16 = new Set<string>()
  for (const market of markets) {
    const gameId = await serverPublicClient.readContract({
      address: V1_6_FACTORY, abi: factoryAbi, functionName: 'gameIdByMarket', args: [market],
    })
    if (gameId !== '') v16.add(market)
  }
  const bets = placed.filter((e) => v16.has(e.address.toLowerCase()))

  if (placed.length === 0) return fail(400, 'NoBetPlaced', 'transaction has no BetPlaced event')
  if (bets.length === 0) return fail(409, 'UnsupportedMarket', 'bet is not on a SportsbookFactory v1.6 market')
  if (bets.length !== 1) return fail(400, 'MultipleBets', 'transaction must contain exactly one BetPlaced')

  const bet = bets[0]
  const [tx, block] = await Promise.all([
    serverPublicClient.getTransaction({ hash: txHash }),
    serverPublicClient.getBlock({ blockNumber: receipt.blockNumber }),
  ])

  // More than one distinct resolvable ref (e.g. a bundle carrying another sender's suffix) is ambiguous: record none.
  const resolved = new Map<string, ResolvedRef>()
  for (const code of refsFromCalldata(tx.input)) {
    const ref = resolveRefForBettor(code, bet.args.bettor)
    if (ref) resolved.set(ref.id.toLowerCase(), ref)
  }
  const ref = resolved.size === 1 ? [...resolved.values()][0] : null

  const record = buildRecord(
    {
      txHash, marketAddress: bet.address, betId: bet.args.betId, bettor: bet.args.bettor,
      stake: bet.args.stake, fee: bet.args.fee,
    },
    ref,
    tx.from.toLowerCase() === RELAY.toLowerCase() ? 'relay' : 'web',
    block.timestamp,
  )
  const written = await recordAttribution(record)
  return NextResponse.json({
    recorded: written,
    ...(written ? {} : { reason: 'AlreadyRecorded' }),
    ref: written ? record.ref : null,
    refType: written ? record.refType : null,
  })
}
