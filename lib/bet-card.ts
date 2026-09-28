import { getAddress, isAddress, type Address } from 'viem'
import { serverPublicClient } from '@/lib/server-client'
import { marketAbi } from '@/lib/contracts'
import { parseGameId } from '@/lib/markets'
import { favoriteHeadline, formatSpread, lineSentence, type Side } from '@/lib/line'

// Server-side. Everything a share card shows, read from chain for one bet.

export interface BetCard {
  marketAddress: Address
  betId: bigint
  gameId: string
  sport: string
  homeTeam: string
  awayTeam: string
  bettor: Address
  side: Side
  team: string
  stake: bigint
  /** "CHIEFS −3.5" */
  pick: string
  /** Same sentence the bet slip's "Your line" box shows, from the bet's lockedZ. */
  lockedLine: string
  /** Header line of the bet slip right now, e.g. "CHIEFS FAVORED BY 3". */
  currentLine: string
  /** Real stakes per side, seed excluded. */
  homeStaked: bigint
  awayStaked: bigint
  /** distributable / this side's stakes, ×100, or null while this side holds no stakes. */
  multipleX100: bigint | null
  bettingOpen: boolean
  settled: boolean
}

export function parseBetParams(market: string, betId: string): { market: Address; betId: bigint } | null {
  if (!isAddress(market) || !/^\d{1,4}$/.test(betId)) return null
  return { market: getAddress(market), betId: BigInt(betId) }
}

export async function loadBetCard(marketAddress: Address, betId: bigint): Promise<BetCard | null> {
  let bet, state, seed
  try {
    ;[bet, state, seed] = await Promise.all([
      serverPublicClient.readContract({ address: marketAddress, abi: marketAbi, functionName: 'getBet', args: [betId] }),
      serverPublicClient.readContract({ address: marketAddress, abi: marketAbi, functionName: 'getMarketState' }),
      serverPublicClient.readContract({ address: marketAddress, abi: marketAbi, functionName: 'protocolSeedTotal' }),
    ])
  } catch {
    return null
  }

  const [gameId, currentZ, greaterPool, lessEqualPool, totalPool, bettingOpen, settled] = state
  const parsed = parseGameId(gameId)
  if (!parsed) return null
  const { parsedHome: homeTeam, parsedAway: awayTeam, parsedSport: sport } = parsed

  const side: Side = bet.greaterThan ? 'home' : 'away'
  const team = side === 'home' ? homeTeam : awayTeam
  const seedPerSide = seed / BigInt(2)
  const nonNegative = (v: bigint) => (v > BigInt(0) ? v : BigInt(0))
  const homeStaked = nonNegative(greaterPool - seedPerSide)
  const awayStaked = nonNegative(lessEqualPool - seedPerSide)
  const distributable = nonNegative(totalPool - seed)
  const sideStaked = side === 'home' ? homeStaked : awayStaked

  return {
    marketAddress,
    betId,
    gameId,
    sport,
    homeTeam,
    awayTeam,
    bettor: bet.bettor,
    side,
    team,
    stake: bet.stake,
    pick: `${team.toUpperCase()} ${formatSpread(bet.lockedZ, side)}`,
    lockedLine: lineSentence(bet.lockedZ, side, homeTeam, awayTeam),
    currentLine: favoriteHeadline(currentZ, homeTeam, awayTeam),
    homeStaked,
    awayStaked,
    multipleX100: sideStaked > BigInt(0) ? (distributable * BigInt(100)) / sideStaked : null,
    bettingOpen,
    settled,
  }
}

export function formatMultiple(x100: bigint): string {
  return `${(Number(x100) / 100).toFixed(2)}×`
}
