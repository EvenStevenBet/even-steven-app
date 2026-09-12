// Pool size, measured in real bettor stakes.

/**
 * Below this much staked money, the Z line still swings hard on ordinary bets.
 * 1,000 USDC, 6 decimals.
 */
export const FIRST_MOVER_POOL_THRESHOLD = BigInt(1_000_000_000)

/**
 * Stakes actually wagered. totalPool includes the protocol seed (1 USDC per
 * side), which counts toward the odds denominator but is never distributable —
 * counting it would make an untouched market look like it already holds $2.
 */
export function stakedPool(totalPool: bigint, protocolSeedTotal: bigint): bigint {
  return totalPool > protocolSeedTotal ? totalPool - protocolSeedTotal : BigInt(0)
}

/**
 * Whether the first-mover edge is still on the table.
 *
 * This is an opportunity, not a hazard. The Z line moves in proportion to how
 * lopsided the pools are, and against a 2 USDC seed base a small absolute stake
 * is a large proportional imbalance — so the line swings furthest while the
 * market is thin. A bettor arriving now can lock a favorable lockedZ before
 * opposing flow arrives and settles the line down; lockedZ is fixed at
 * placement and later bets cannot move it. Once real stakes pass the threshold
 * the line has stabilised and the edge is simply gone, so the label goes with it.
 *
 * Deliberately carries no cautionary framing: this is not a liquidity warning.
 */
export function isFirstMoverMarket(staked: bigint | undefined): boolean {
  return staked !== undefined && staked < FIRST_MOVER_POOL_THRESHOLD
}
