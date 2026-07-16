// Types and utilities for market data.
// Market list comes from the Google Sheet CSV; live data from the chain.

export interface MarketRow {
  gameId: string
  sport: string
  homeTeam: string
  awayTeam: string
  gameDate: string       // ISO date string e.g. "2026-09-06"
  status: string         // "active" | "coming-soon" | "settled" | etc. (sheet-managed)
  marketAddress: string  // empty = coming-soon; populated = live contract
  openLine: string       // display fallback only; chain wins on conflict
  bettingOpensAt: string // ISO date or human string
  notes: string
}

// On-chain market lifecycle states
export type MarketLifecycle =
  | 'open'           // accepting bets
  | 'closed'         // game over, UMA assertion in liveness window (~2hr)
  | 'settled'        // payouts claimable
  | 'cancelled'      // full refund (no fee), 90-day claim window
  | 'refund'         // 7-day backstop: anyone can triggerRefund()
  | 'coming-soon'    // no marketAddress yet

export interface ParsedMarket extends MarketRow {
  isLive: boolean          // true if marketAddress is set
  parsedHome: string       // display team name from gameId or sheet column
  parsedAway: string
  parsedSport: string
  parsedDate: string       // YYYY-MM-DD from gameId
  gameNumber?: string      // "G1" | "G2" for MLB doubleheaders
}

// gameId format: SPORT-YYYY-MM-DD-HOME-TeamName-AWAY-TeamName[-G1]
// e.g. "NFL-2026-09-06-HOME-Chiefs-AWAY-Ravens"
export function parseGameId(gameId: string): Omit<ParsedMarket, keyof MarketRow | 'isLive'> | null {
  const match = gameId.match(
    /^([A-Z]+)-(\d{4}-\d{2}-\d{2})-HOME-(.+?)-AWAY-(.+?)(-G[12])?$/
  )
  if (!match) return null
  return {
    parsedSport:  match[1],
    parsedDate:   match[2],
    parsedHome:   match[3].replace(/-/g, ' '),
    parsedAway:   match[4].replace(/-/g, ' '),
    gameNumber:   match[5]?.slice(1), // "G1" | "G2" | undefined
  }
}

// Z values are 4-decimal fixed-point: -35000 = -3.5, 0 = PK
export function formatLine(zValue: number): string {
  if (zValue === 0) return 'PK'
  const val = zValue / 10000
  return val > 0 ? `+${val.toFixed(1)}` : val.toFixed(1)
}

export function enrichMarket(row: MarketRow): ParsedMarket {
  const parsed = parseGameId(row.gameId)
  return {
    ...row,
    isLive:      Boolean(row.marketAddress),
    parsedSport: parsed?.parsedSport  ?? row.sport,
    parsedDate:  parsed?.parsedDate   ?? row.gameDate,
    parsedHome:  parsed?.parsedHome   ?? row.homeTeam,
    parsedAway:  parsed?.parsedAway   ?? row.awayTeam,
    gameNumber:  parsed?.gameNumber,
  }
}
