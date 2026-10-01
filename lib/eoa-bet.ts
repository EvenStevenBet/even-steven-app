import type { Address, Hash, Hex, PublicClient, TransactionReceipt } from 'viem'
import { erc20Abi, marketAbi } from './contracts'

// The EOA bet: approve USDC to the market if needed, then placeBet.
//
// Read-after-write lag: the approve receipt can come from a node that is ahead of the one
// answering the next read, so placeBet's gas estimate ran against a node that hadn't seen
// the approval yet and reverted "ERC20: transfer amount exceeds allowance" — every first
// EOA bet on a market, fixed by retrying. After our own approval we now (1) poll the
// allowance on the same client until it shows, (2) estimate placeBet at the approve block
// or later, and (3) retry that estimate a couple of times on a lag-shaped error.

const MAX_UINT256 = (BigInt(1) << BigInt(256)) - BigInt(1)

export const ALLOWANCE_WAIT_MS = 15_000
const ALLOWANCE_POLL_MS = 750
const ESTIMATE_RETRIES = 2
const ESTIMATE_RETRY_MS = 1_500

/** The approval is confirmed on-chain but the network hasn't caught up within the cap. */
export class ApprovalLagError extends Error {
  constructor() {
    super('approval confirmed on-chain; reads have not caught up yet')
    this.name = 'ApprovalLagError'
  }
}

type WriteContract = (args: {
  address: Address
  abi: typeof erc20Abi | typeof marketAbi
  functionName: 'approve' | 'placeBet'
  args: readonly unknown[]
  gas: bigint
  dataSuffix?: Hex
}) => Promise<Hash>

export interface EoaBetParams {
  publicClient: PublicClient
  writeContract: WriteContract
  account: Address
  usdc: Address
  market: Address
  greaterThan: boolean
  stake: bigint
  totalCost: bigint
  betSuffix?: Hex
  approveSuffix?: Hex
  onStep: (step: 'awaiting_approval_signature' | 'confirming_approval' | 'awaiting_bet_signature' | 'confirming_bet') => void
  sleep?: (ms: number) => Promise<void>
  allowanceWaitMs?: number
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

// Wallets' own gas estimation has returned wildly inflated values (~140M gas) for these
// calls, which RPCs reject before broadcast; estimate here and pass a buffered value instead.
const withGasBuffer = (gas: bigint) => (gas * BigInt(120)) / BigInt(100)

/** A read that doesn't yet reflect a transaction we just saw confirmed. */
export function isReadLagError(err: unknown): boolean {
  const text = err instanceof Error ? `${err.message} ${(err as { details?: string }).details ?? ''}` : String(err)
  return /exceeds allowance|header not found|unknown block|block not found|could not be found|missing trie node/i.test(text)
}

/** Polls allowance(owner, spender) on this client until it reaches `needed`; false at the cap. */
export async function waitForAllowance(
  publicClient: PublicClient, usdc: Address, owner: Address, spender: Address, needed: bigint,
  { timeoutMs = ALLOWANCE_WAIT_MS, sleep = defaultSleep }: { timeoutMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const allowance = await publicClient.readContract({ address: usdc, abi: erc20Abi, functionName: 'allowance', args: [owner, spender] })
      if (allowance >= needed) return true
    } catch {
      // a lagging or flaky read: keep polling until the cap
    }
    if (Date.now() >= deadline) return false
    await sleep(ALLOWANCE_POLL_MS)
  }
}

export async function placeBetEoa(p: EoaBetParams): Promise<{ hash: Hash; receipt: TransactionReceipt }> {
  const sleep = p.sleep ?? defaultSleep
  p.onStep('awaiting_approval_signature')

  // Skip a redundant approval if this address already approved enough for this market —
  // e.g. a retry after placeBet was rejected post-approval, or after an ApprovalLagError.
  const current = await p.publicClient.readContract({ address: p.usdc, abi: erc20Abi, functionName: 'allowance', args: [p.account, p.market] })

  let approvedAt: bigint | null = null
  if (current < p.totalCost) {
    const approveGas = await p.publicClient.estimateContractGas({
      address: p.usdc, abi: erc20Abi, functionName: 'approve', args: [p.market, MAX_UINT256], account: p.account, dataSuffix: p.approveSuffix,
    })
    const approveHash = await p.writeContract({
      address: p.usdc, abi: erc20Abi, functionName: 'approve', args: [p.market, MAX_UINT256], gas: withGasBuffer(approveGas), dataSuffix: p.approveSuffix,
    })
    p.onStep('confirming_approval')
    const approveReceipt = await p.publicClient.waitForTransactionReceipt({ hash: approveHash })
    if (approveReceipt.status !== 'success') throw new Error('USDC approval transaction reverted on-chain.')
    approvedAt = approveReceipt.blockNumber

    // (1) Same client that will simulate placeBet must see the approval first.
    const visible = await waitForAllowance(p.publicClient, p.usdc, p.account, p.market, p.totalCost, { timeoutMs: p.allowanceWaitMs, sleep })
    if (!visible) throw new ApprovalLagError()
  }

  p.onStep('awaiting_bet_signature')
  let betGas: bigint | undefined
  for (let attempt = 0; betGas === undefined; attempt++) {
    try {
      betGas = await p.publicClient.estimateContractGas({
        address: p.market, abi: marketAbi, functionName: 'placeBet', args: [p.greaterThan, p.stake], account: p.account, dataSuffix: p.betSuffix,
        // (2) At the approve block or later: never against state from before our approval.
        ...(approvedAt !== null ? { blockNumber: approvedAt } : {}),
      })
    } catch (err) {
      // (3) Right after our own confirmed approval, a lag-shaped error is retried, not shown.
      if (approvedAt === null || !isReadLagError(err) || attempt >= ESTIMATE_RETRIES) throw err
      await sleep(ESTIMATE_RETRY_MS)
    }
  }

  const hash = await p.writeContract({
    address: p.market, abi: marketAbi, functionName: 'placeBet', args: [p.greaterThan, p.stake], gas: withGasBuffer(betGas), dataSuffix: p.betSuffix,
  })
  p.onStep('confirming_bet')
  const receipt = await p.publicClient.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') throw new Error('placeBet transaction reverted on-chain.')
  return { hash, receipt }
}
