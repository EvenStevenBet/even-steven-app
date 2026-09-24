// Forward-looking payout quote, computed client/server-side from raw
// getMarketState() + protocolSeedTotal() values instead of an extra RPC call
// to getMarketEV().
//
// SportsbookMarket-v1_10's own getMarketEV()/simulatePayout() are correct as
// deployed — the v1.9 bug where the winning-side denominator carried a
// hardcoded 1 USDC PROTOCOL_SEED regardless of the market's actual seed is
// fixed on-chain (seedPerSide is now read from protocolSeedTotal, which is a
// per-market immutable that may be 0 — see SportsbookMarket-v1_10.sol
// simulatePayout/getMarketEV). Verified against the live Bills/Lions market:
// getMarketEV(100 USDC, true) returned 101941747, matching this formula with
// protocolSeedTotal read from chain, not a hardcoded seed assumption.
//
// This file mirrors that on-chain math exactly so callers avoid an extra RPC
// round trip, using each pool's own protocolSeedTotal (already fetched to
// build PoolState) rather than assuming every market seeds 1 USDC/side.
//
// This is still an add-on-top simulation for a stake THE BETTOR HAS NOT YET
// PLACED — it answers "what if I bet this now," which is the only question a
// pre-bet quote can honestly answer. It does NOT answer "what is my
// already-placed bet worth" — that number is smaller in every denominator
// (no add-on-top) and only computable for a bet that has actually landed;
// conflating the two is the bug the post-bet scenario box had before it was
// hidden. Never reuse this for an already-placed bet's own stake/side.

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
 * computed client/server-side from raw getMarketState() values to save an
 * RPC round trip. The contract function is correct as deployed (v1.10+);
 * this mirrors its identity exactly rather than correcting it.
 */
export function quoteMarketEV(pool: PoolState, stake: bigint, greaterThan: boolean): QuoteResult {
  if (stake === BigInt(0)) return { currentPayout: BigInt(0), liquidPayout: BigInt(0) }

  const seedPerSide = pool.protocolSeedTotal / BigInt(2)
  const simGreater = pool.greaterPool + (greaterThan ? stake : BigInt(0))
  const simLessEqual = pool.lessEqualPool + (greaterThan ? BigInt(0) : stake)
  const simTotal = pool.totalPool + stake
  const distributable = simTotal - pool.protocolSeedTotal

  const winningSide = greaterThan ? simGreater : simLessEqual
  const realWinningStake = winningSide - seedPerSide
  const currentPayout = realWinningStake > BigInt(0) ? (stake * distributable) / realWinningStake : BigInt(0)

  // liquidPayout at true liquidity is always exactly 2x the stake, regardless
  // of seed — same identity SportsbookMarket-v1_10.getMarketEV() uses.
  const liquidPayout = stake * BigInt(2)

  return { currentPayout, liquidPayout }
}
