// Line math for the Z line.
//
// Every outcome string in the UI is derived from the raw int256 the contract
// returns (currentZ / lockedZ), never from a rounded display value — a rounded
// value loses exactly the information the outcome text depends on. The old
// hardcoded "or tie" sublabel is what that mistake looks like in production.
//
// Contract semantics (SportsbookMarket-v1_9.sol):
//   finalSpread = home score − away score. The UMA claim string spells it out:
//     "Positive = HOME team (first named in gameId) won by that margin.
//      Negative = AWAY team (second named) won. Zero = tie."
//   home bet = placeBet(greaterThan: true)  → wins iff finalSpread * 10000 >  lockedZ
//   away bet = placeBet(greaterThan: false) → wins iff finalSpread * 10000 <= lockedZ
//
// finalSpread is a whole number, so "> z" over the integers is ">= floor(z) + 1".
// Call that threshold m:
//
//     HOME WINS IFF MARGIN >= m,  AWAY WINS ON EVERYTHING ELSE.
//
// There is no third branch — every bet resolves, there are no pushes. That is
// why the plain-English outcome text is authoritative over the spread number:
// on a whole-number line the favorite wins on the exact margin where a
// sportsbook would push, and the spread alone can't say so.

const Z_SCALE = BigInt(10_000)
const ZERO = BigInt(0)
const ONE = BigInt(1)

export type Side = 'home' | 'away'

// BigInt division truncates toward zero; Z is routinely negative, so floor by hand.
function floorDiv(a: bigint, b: bigint): bigint {
  const q = a / b
  return a % b !== ZERO && a < ZERO !== b < ZERO ? q - ONE : q
}

/** m — the smallest home margin that wins. Home wins iff margin >= m. */
export function winThreshold(zRaw: bigint): number {
  return Number(floorDiv(zRaw, Z_SCALE) + ONE)
}

/** Only an exact zero is a true pick'em; z = −0.0001 is a different market. */
export function isPickEm(zRaw: bigint): boolean {
  return zRaw === ZERO
}

/** Conventional spread quoted to a side: home is quoted at −z, away at +z. */
export function sideSpread(zRaw: bigint, side: Side): number {
  const z = Number(zRaw) / 10_000
  return side === 'home' ? -z : z
}

function formatSigned(value: number): string {
  const abs = Math.abs(value)
  const body = Number.isInteger(abs) ? abs.toString() : abs.toFixed(1)
  return `${value > 0 ? '+' : '−'}${body}`
}

/**
 * The spread as a bettor reads it, rounded to a tenth. Display only — the
 * outcome text below never passes through this.
 */
export function formatSpread(zRaw: bigint, side: Side): string {
  if (isPickEm(zRaw)) return 'PICK’EM'
  const rounded = Math.round(sideSpread(zRaw, side) * 10) / 10
  if (rounded === 0) return 'PICK’EM'
  return formatSigned(rounded)
}

/** The smallest margin, in this side's own favour, that wins for it. */
export function sideNeed(zRaw: bigint, side: Side): number {
  const m = winThreshold(zRaw)
  // Away wins iff home margin <= m − 1, i.e. away's own margin >= 1 − m.
  return side === 'home' ? m : 1 - m
}

function outcomeFromNeed(need: number): string {
  if (need >= 2) return `win by ${need} or more`
  if (need === 1) return 'win outright'
  if (need === 0) return 'win or tie'
  if (need === -1) return 'win, tie, or lose by 1'
  return `win, tie, or lose by up to ${-need}`
}

/** Plain-English win condition for a side. Always derived from the raw Z. */
export function outcomeText(zRaw: bigint, side: Side): string {
  return outcomeFromNeed(sideNeed(zRaw, side))
}

/**
 * The line attached to the team that owns it: { team: "49ers", spread: "−2" }.
 * `team` is null on a pick'em, where no one is laying points.
 */
export function favoriteQuote(
  zRaw: bigint,
  homeTeam: string,
  awayTeam: string,
): { team: string | null; spread: string; by: number } {
  const z = Number(zRaw) / 10_000
  const by = Math.round(Math.abs(z) * 10) / 10
  if (isPickEm(zRaw) || by === 0) return { team: null, spread: 'PICK’EM', by: 0 }
  // Home is quoted at −z, so z > 0 means home is laying points.
  const side: Side = z > 0 ? 'home' : 'away'
  return {
    team: side === 'home' ? homeTeam : awayTeam,
    spread: formatSpread(zRaw, side),
    by,
  }
}

/**
 * "49ERS FAVORED BY 2" — attaches the line to a team. A bare "−2" doesn't say
 * whose −2 it is.
 */
export function favoriteHeadline(zRaw: bigint, homeTeam: string, awayTeam: string): string {
  const { team, by } = favoriteQuote(zRaw, homeTeam, awayTeam)
  if (team === null) return 'PICK’EM — NO FAVORITE'
  const body = Number.isInteger(by) ? by.toString() : by.toFixed(1)
  return `${team.toUpperCase()} FAVORED BY ${body}`
}

/** "49ERS −2 — you win if the 49ers win by 2 or more" */
export function lineSentence(zRaw: bigint, side: Side, homeTeam: string, awayTeam: string): string {
  const team = side === 'home' ? homeTeam : awayTeam
  return `${team.toUpperCase()} ${formatSpread(zRaw, side)} — you win if the ${team} ${outcomeText(zRaw, side)}`
}
