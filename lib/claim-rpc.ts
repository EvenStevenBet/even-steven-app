import { createPublicClient, http } from 'viem'
import { serverPublicClient } from '@/lib/server-client'

// Server-side only. The read client for relayed claiming, used only by
// lib/claim.ts. Same endpoint and chain as serverPublicClient — so the same
// SERVER_ALCHEMY_KEY and the same production guard — but a call gives up after
// CLAIM_RPC_TIMEOUT_MS and retries once, instead of viem's 10s x 4 attempts.
// One slow node then costs a claim request at most CLAIM_RPC_WORST_CASE_MS per
// read, which the chunk time budget in lib/claim.ts is sized against.
export const CLAIM_RPC_TIMEOUT_MS = 8_000
export const CLAIM_RPC_RETRY_COUNT = 1
// Both attempts timing out, plus viem's first retry delay (150ms).
export const CLAIM_RPC_WORST_CASE_MS = CLAIM_RPC_TIMEOUT_MS * (CLAIM_RPC_RETRY_COUNT + 1) + 150

export function createClaimReadClient(url: string) {
  return createPublicClient({
    chain: serverPublicClient.chain,
    transport: http(url, { timeout: CLAIM_RPC_TIMEOUT_MS, retryCount: CLAIM_RPC_RETRY_COUNT }),
  })
}

// serverPublicClient is always built with an explicit URL; never guess another endpoint.
const serverUrl = serverPublicClient.transport.url
if (!serverUrl) throw new Error('serverPublicClient has no RPC URL; refusing to build the claim read client')

export const claimPublicClient = createClaimReadClient(serverUrl)
