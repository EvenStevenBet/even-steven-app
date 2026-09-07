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
  'event BetPlaced(address indexed bettor, uint256 indexed betId, uint256 stake, uint256 fee, bool greaterThan, int256 lockedZ)',
])

export const erc20Abi = parseAbi([
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address account) view returns (uint256)',
])
