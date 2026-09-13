// Corrected forward-looking payout quote.
//
// getMarketEV()/simulatePayout() on SportsbookMarket-v1_9 simulate adding the
// queried stake on top of the current pool — exactly right for a live quote —
// but the winning-side denominator they use (greaterPool/lessEqualPool) still
// carries that side's PROTOCOL_SEED (1 USDC), while the real settlement
// denominator never does: _sumWinningStakes() sums bets[i].stake only — the
// seed is never pushed into the bets[] array (SportsbookMarket-v1_9.sol
// _sumWinningStakes, ~line 526; _calculatePayout, ~line 538). So the contract's
// own quote functions systematically under-quote by treating 1 USDC of
// non-competing seed money as if it were a competing winning stake. The error
// is largest on thin pools and shrinks to negligible as pools deepen.
//
// This mirrors getMarketEV's own math exactly, with PROTOCOL_SEED stripped
// from the winning-side denominator only (never from `distributable`, which
// already correctly subtracts the aggregate protocolSeedTotal — subtracting
// PROTOCOL_SEED here too would double-count).
//
// This is still an add-on-top simulation for a stake THE BETTOR HAS NOT YET
// PLACED — it answers "what if I bet this now," which is the only question a
// pre-bet quote can honestly answer. It does NOT answer "what is my
// already-placed bet worth" — that number is smaller in every denominator
// (no add-on-top) and only computable for a bet that has actually landed;
// conflating the two is the bug the post-bet scenario box had before it was
// hidden. Never reuse this for an already-placed bet's own stake/side.
export const PROTOCOL_SEED = BigInt(1_000_000) // 1 USDC, matches the on-chain constant

export interface PoolState {
  greaterPool: bigint
  lessEqualPool: bigint
  totalPool: bigint
  protocolSeedTotal: bigint
}

export interface QuoteResult {
  currentPayout: bigint
  liquidPayout: bigint
}

/**
 * quoteMarketEV(pool, stake, greaterThan) — same shape as getMarketEV's return,
 * computed client/server-side from raw getMarketState() values instead of
 * calling the (seed-inflated) contract function.
 */
export function quoteMarketEV(pool: PoolState, stake: bigint, greaterThan: boolean): QuoteResult {
  if (stake === BigInt(0)) return { currentPayout: BigInt(0), liquidPayout: BigInt(0) }

  const simGreater = pool.greaterPool + (greaterThan ? stake : BigInt(0))
  const simLessEqual = pool.lessEqualPool + (greaterThan ? BigInt(0) : stake)
  const simTotal = pool.totalPool + stake
  const distributable = simTotal - pool.protocolSeedTotal

  const winningSide = greaterThan ? simGreater : simLessEqual
  const realWinningStake = winningSide - PROTOCOL_SEED
  const currentPayout = realWinningStake > BigInt(0) ? (stake * distributable) / realWinningStake : BigInt(0)

  const liquidSide = simTotal / BigInt(2)
  const realLiquidSide = liquidSide - PROTOCOL_SEED
  const liquidPayout = realLiquidSide > BigInt(0) ? (stake * distributable) / realLiquidSide : BigInt(0)

  return { currentPayout, liquidPayout }
}
