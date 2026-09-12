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
])

export const erc20Abi = parseAbi([
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address account) view returns (uint256)',
])

// Fragments for the SportsbookFactory contract — server-side agent API only.
// Signatures confirmed against SportsbookFactory-v1_4.sol.
export const factoryAbi = parseAbi([
  'function getOpenMarkets() view returns (address[])',
  'function marketByGameId(string) view returns (address)',
])
