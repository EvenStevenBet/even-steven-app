import { parseAbi } from 'viem'

// Fragments for individual SportsbookMarket contracts (not the factory).
// Signatures confirmed against SportsbookMarket.sol — see CLAUDE.md for the
// fee model and win-condition semantics.
export const marketAbi = parseAbi([
  'function placeBet(bool greaterThan, uint256 stake)',
  'function simulatePayout(uint256 stake, bool greaterThan) view returns (uint256 estimatedPayout)',
  'function getMarketEV(uint256 stake, bool greaterThan) view returns (uint256 currentPayout, uint256 liquidPayout, uint256 impliedVig)',
  'function bettingOpen() view returns (bool)',
  'function getMarketState() view returns (string _gameId, int256 z, uint256 gPool, uint256 lePool, uint256 tPool, bool isOpen, bool isSettled)',
  // Aggregate seed (2 × PROTOCOL_SEED). It counts toward the odds denominator
  // but is excluded from the distributable pool, so the displayed pool size
  // subtracts it — otherwise a brand-new market looks like it holds $2.
  'function protocolSeedTotal() view returns (uint256)',
  'event BetPlaced(address indexed bettor, uint256 indexed betId, uint256 stake, uint256 fee, bool greaterThan, int256 lockedZ)',
  // Server-side view functions (agent API) — signatures confirmed against
  // SportsbookMarket-v1_9.sol. getBetsByAddress/getBet wrap the public
  // `betsByAddress` mapping and `bets` array with named return values.
  'struct Bet { address bettor; uint256 stake; bool greaterThan; int256 lockedZ; bool claimed; }',
  'function getBetsByAddress(address bettor) view returns (uint256[])',
  'function getBet(uint256 betId) view returns (Bet)',
  // My Bets page (claim flow) — confirmed live against SportsbookMarket-v1_9.sol
  // and the deployed test market. getMarketStatus() carries canceled/paused/
  // assertion state; refundMode/finalSpread/cachedWinningStakes are auto-generated
  // public-variable getters used to replicate _calculatePayout() client-side so a
  // claimable bet's payout can be shown before the claim tx is sent.
  'function getMarketStatus() view returns (bool isCanceled, bool isPaused, bool assertionActive, uint256 claimDeadline, uint256 betsRemaining)',
  'function refundMode() view returns (bool)',
  'function finalSpread() view returns (int256)',
  'function cachedWinningStakes() view returns (uint256)',
  'function totalPool() view returns (uint256)',
  'function claimPayout(uint256 betId)',
  'function claimAllPayouts()',
  'event PayoutClaimed(address indexed bettor, uint256 amount)',
  // v1.11 relayed (non-custodial) entry points — signatures confirmed against
  // SportsbookMarket-v1_11.sol, which is byte-identical to the BaseScan-verified
  // source of every SportsbookFactory v1.6 market. Only v1.6 markets have these.
  'struct Authorization { uint256 validAfter; uint256 validBefore; bytes32 nonce; bytes32 salt; uint8 v; bytes32 r; bytes32 s; }',
  'struct AuthorizationBytes { uint256 validAfter; uint256 validBefore; bytes32 nonce; bytes32 salt; bytes signature; }',
  'function placeBetFor(address bettor, bool greaterThan, uint256 stake, Authorization auth)',
  'function placeBetForWithSignature(address bettor, bool greaterThan, uint256 stake, AuthorizationBytes auth)',
  'function claimPayoutFor(address bettor, uint256[] betIds)',
  'function FEE_PERCENT() view returns (uint256)',
  'event BetClaimed(address indexed bettor, uint256 indexed betId, uint256 payout)',
  'event SettlementDetails(uint256 distributable, uint256 winningStakes)',
  // Every custom error declared in SportsbookMarket-v1_11.sol, so viem can
  // decode any revert by name.
  'error InvalidAddress()',
  'error InvalidSpreadBounds()',
  'error SpreadBoundsTooWide()',
  'error FeeTooLow()',
  'error FeeTooHigh()',
  'error AlreadyOpen()',
  'error MarketEnded()',
  'error EmptyGameId()',
  'error OracleZOutOfRange()',
  'error SeedTransferFailed()',
  'error BettingIsClosed()',
  'error BelowMinBet()',
  'error MarketFull()',
  'error StakeTransferFailed()',
  'error AlreadyClosed()',
  'error MarketAlreadyEnded()',
  'error BettingStillOpen()',
  'error BettingNeverClosed()',
  'error RefundTimeoutNotReached()',
  'error CloseFirstBeforeSettlement()',
  'error AssertionAlreadyPending()',
  'error SpreadOutOfRange()',
  'error BondTransferFailed()',
  'error NoActiveAssertion()',
  'error NotSettledYet()',
  'error InvalidBetId()',
  'error ClaimWindowExpired()',
  'error NotYourBet()',
  'error AlreadyClaimed()',
  'error NoPayout()',
  'error InsufficientBalance()',
  'error TransferFailed()',
  'error NothingToClaim()',
  'error ClaimWindowNotExpired()',
  'error NothingToSweep()',
  'error AssertionIsActive()',
  'error InvalidDestination()',
  'error AmountZero()',
  'error AmountExceedsRecoverable()',
  'error FeeTransferFailed()',
  'error InvalidIdentifier()',
  'error BadAuthorizationNonce()',
  'error InvalidBettor()',
  'error MarketPaused()',
  'error NotOwner()',
])

export const erc20Abi = parseAbi([
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address account) view returns (uint256)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
])

// Fragments for the SportsbookFactory contract — server-side agent API only.
// Signatures confirmed against SportsbookFactory-v1_4.sol.
export const factoryAbi = parseAbi([
  'function getOpenMarkets() view returns (address[])',
  'function marketByGameId(string) view returns (address)',
  // v1.6: non-empty only for markets this factory created.
  'function gameIdByMarket(address) view returns (string)',
])
