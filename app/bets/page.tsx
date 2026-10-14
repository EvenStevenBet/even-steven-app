'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { BaseError } from 'viem'
import { useAccount, usePublicClient, useWriteContract } from 'wagmi'
import { ConnectWalletModal } from '@/components/ConnectWalletModal'
import { BASESCAN_URL } from '@/lib/chain'
import { factoryAbi, marketAbi, V1_6_FACTORY } from '@/lib/contracts'
import { enrichMarket } from '@/lib/markets'
import type { MarketRow, ParsedMarket } from '@/lib/markets'
import { formatUsdc } from '@/lib/format'
import { formatSpread, lineSentence } from '@/lib/line'
import type { Side } from '@/lib/line'
import { useWalletBets } from '@/lib/useWalletBets'
import type { WalletBet } from '@/lib/bets'
import { ShareButton } from '@/components/ShareButton'
import { attributionSuffix } from '@/lib/attribution'

function describeError(err: unknown): string {
  if (err instanceof BaseError) return err.shortMessage
  return err instanceof Error ? err.message : 'Something went wrong.'
}

function betSide(bet: WalletBet): Side {
  return bet.side
}

type Hex = `0x${string}`

interface RelayIncomplete {
  error: string
  message: string
  txHash?: Hex
  retryAfterSeconds?: number
}

type RelayClaim =
  | { kind: 'claimed'; txHashes: Hex[]; betIds: bigint[]; remainingCount: number; incomplete?: RelayIncomplete }
  | { kind: 'nothing' }
  | { kind: 'pending'; txHash: Hex }
  | { kind: 'busy'; retryAfterSeconds: number }
  | { kind: 'unsupported' }
  | { kind: 'unavailable' }

// How long to wait for a relayed claim the route answered SubmissionPending
// for (it already waited 15s). A dropped tx then errors instead of hanging.
const PENDING_CLAIM_TIMEOUT_MS = 120_000
// One request claims up to 200 bets (8 x 25); a market holds at most 1000.
const MAX_CLAIM_REQUESTS = 6
const MAX_BUSY_RETRIES = 2
const RELAY_UNAVAILABLE_MESSAGE = "Relay unavailable — you'll need ETH in your wallet to claim."
const LEGACY_MARKET_MESSAGE = 'Older market — claiming needs a small amount of ETH in your wallet for gas.'
// Relay-side errors that mean it can submit nothing more right now.
const RELAY_DOWN_ERRORS = new Set(['RelayUnderfunded', 'RelayNotConfigured', 'LockServiceUnavailable'])

// A relay error that still carries a submitted tx (SubmissionReverted,
// CustodyInvariantViolated), so the BaseScan link survives into the error state.
class RelayClaimError extends Error {
  constructor(message: string, readonly txHash?: Hex) {
    super(message)
  }
}

async function relayClaim(marketAddress: string, bettor: string): Promise<RelayClaim> {
  const res = await fetch('/api/claim', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ marketAddress, bettor }),
  })
  const data = await res.json().catch(() => ({}))
  if (res.ok) {
    if (!data.txHashes?.length) return { kind: 'nothing' }
    return {
      kind: 'claimed',
      txHashes: data.txHashes,
      betIds: (data.betIds as string[]).map(id => BigInt(id)),
      remainingCount: data.remainingCount ?? 0,
      incomplete: data.incomplete,
    }
  }
  if (res.status === 504 && data.txHash) return { kind: 'pending', txHash: data.txHash }
  if (data.error === 'RelayBusy') return { kind: 'busy', retryAfterSeconds: data.retryAfterSeconds ?? 5 }
  if (data.error === 'UnsupportedMarket') return { kind: 'unsupported' }
  if (res.status === 503) return { kind: 'unavailable' }
  if (res.status === 429) throw new Error('Too many claim requests — wait a minute and try again.')
  throw new RelayClaimError(data.message ?? `Claim failed (HTTP ${res.status}).`, data.txHash)
}

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

// needs_wallet: the relay can't take this claim; the user has been told they
// pay gas, and the next click claims from the wallet.
type ClaimStep = 'idle' | 'needs_wallet' | 'awaiting_signature' | 'confirming' | 'success' | 'error'
interface ClaimState {
  step: ClaimStep
  txHash?: Hex
  error?: string
  notice?: string
  progress?: { claimed: number; total: number }
}

export default function BetsPage() {
  const { address, isConnected } = useAccount()
  const publicClient = usePublicClient()
  const { writeContractAsync } = useWriteContract()

  const [markets, setMarkets] = useState<ParsedMarket[] | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch('/api/markets')
      .then(res => res.json())
      .then((data: MarketRow[]) => {
        if (cancelled) return
        setMarkets(data.map(enrichMarket))
      })
      .catch(() => {
        if (!cancelled) setMarkets([])
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Only markets with a live contract are worth scanning — coming-soon rows
  // have no marketAddress and nothing has ever been bet on them.
  const scannableMarkets = useMemo(
    () => (markets ?? []).filter(m => m.isLive && m.status?.trim().toLowerCase() !== 'coming_soon'),
    [markets]
  )

  const { bets, loading, scannedCount, totalCount, markClaimed, errors } = useWalletBets(
    scannableMarkets,
    address,
    publicClient
  )

  const [claimStates, setClaimStates] = useState<Record<string, ClaimState>>({})
  // Claimable markets not created by Factory v1.6 (no claimPayoutFor), keyed by address.
  const [legacyMarkets, setLegacyMarkets] = useState<Record<string, boolean>>({})

  const active = bets.filter(b => b.status === 'active')
  const awaiting = bets.filter(b => b.status === 'awaiting')
  const claimable = bets.filter(b => b.status === 'claimable')
  const history = bets.filter(b => b.status === 'won' || b.status === 'lost' || b.status === 'refunded')

  const claimableByMarket = useMemo(() => {
    const map = new Map<string, WalletBet[]>()
    for (const bet of claimable) {
      const key = bet.market.marketAddress
      map.set(key, [...(map.get(key) ?? []), bet])
    }
    return map
  }, [claimable])

  // Find older markets up front, so the ETH notice shows before the click.
  const claimableMarketKey = Array.from(claimableByMarket.keys()).sort().join(',')
  useEffect(() => {
    if (!publicClient || !claimableMarketKey) return
    const addresses = claimableMarketKey.split(',') as Hex[]
    let cancelled = false
    publicClient
      .multicall({
        contracts: addresses.map(address => ({
          address: V1_6_FACTORY,
          abi: factoryAbi,
          functionName: 'gameIdByMarket' as const,
          args: [address] as const,
        })),
      })
      .then(results => {
        if (cancelled) return
        const legacy: Record<string, boolean> = {}
        // A failed read stays unknown; the route's 409 still surfaces the notice.
        results.forEach((r, i) => {
          if (r.status === 'success') legacy[addresses[i]] = r.result === ''
        })
        setLegacyMarkets(prev => ({ ...prev, ...legacy }))
      })
      .catch(err => console.error('legacy market check failed:', err))
    return () => {
      cancelled = true
    }
  }, [publicClient, claimableMarketKey])

  function claimStateFor(key: string, marketAddress: string): ClaimState | undefined {
    return claimStates[key] ?? (legacyMarkets[marketAddress] ? { step: 'needs_wallet', notice: LEGACY_MARKET_MESSAGE } : undefined)
  }

  // Claims go through the relay (POST /api/claim): the wallet only identifies
  // the bettor, signs nothing and needs no ETH. Each request claims up to 200
  // of the bettor's bets on the market (25 per tx); this loops until
  // remainingCount is 0. Nothing falls back to the wallet silently: older
  // markets (no claimPayoutFor) and a relay that can't submit show a notice
  // first, and only the next click claims from the wallet, paying gas.
  async function runClaim(
    key: string,
    marketAddress: string,
    marketBets: WalletBet[],
    walletCall: { functionName: 'claimPayout'; args: [bigint] } | { functionName: 'claimAllPayouts' }
  ) {
    if (!publicClient || !address) return
    const viaWallet = claimStateFor(key, marketAddress)?.step === 'needs_wallet'
    const set = (state: ClaimState) => setClaimStates(prev => ({ ...prev, [key]: state }))
    let txHash: Hex | undefined
    let progress = { claimed: 0, total: marketBets.length }

    const waitForPending = async (hash: Hex) => {
      txHash = hash
      set({ step: 'confirming', txHash, progress })
      const receipt = await publicClient
        .waitForTransactionReceipt({ hash, timeout: PENDING_CLAIM_TIMEOUT_MS })
        .catch(() => {
          throw new RelayClaimError('Claim not confirmed after 2 minutes and may have been dropped. Check BaseScan, then try again.', hash)
        })
      if (receipt.status !== 'success') throw new RelayClaimError('Claim transaction reverted on-chain.', hash)
    }

    try {
      if (viaWallet) {
        set({ step: 'awaiting_signature' })
        const addr = marketAddress as Hex
        const gas = await publicClient.estimateContractGas({
          address: addr,
          abi: marketAbi,
          ...walletCall,
          account: address,
          dataSuffix: attributionSuffix(),
        })
        txHash = await writeContractAsync({
          address: addr,
          abi: marketAbi,
          ...walletCall,
          gas: (gas * BigInt(120)) / BigInt(100),
          dataSuffix: attributionSuffix(),
        })
        set({ step: 'confirming', txHash })
        const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash })
        if (receipt.status !== 'success') throw new Error(`${walletCall.functionName} transaction reverted on-chain.`)
        set({ step: 'success', txHash })
        markClaimed(marketAddress, walletCall.functionName === 'claimPayout' ? walletCall.args : marketBets.map(b => b.betId))
        return
      }

      set({ step: 'confirming', progress })
      let notice: string | undefined
      for (let request = 0, busyRetries = 0; request < MAX_CLAIM_REQUESTS; request++) {
        const r = await relayClaim(marketAddress, address)

        if (r.kind === 'unsupported' || r.kind === 'unavailable') {
          if (r.kind === 'unsupported') setLegacyMarkets(prev => ({ ...prev, [marketAddress]: true }))
          set({ step: 'needs_wallet', txHash, progress, notice: r.kind === 'unsupported' ? LEGACY_MARKET_MESSAGE : RELAY_UNAVAILABLE_MESSAGE })
          return
        }
        if (r.kind === 'busy') {
          if (busyRetries++ >= MAX_BUSY_RETRIES) throw new RelayClaimError('Relay busy — try again in a few seconds.', txHash)
          await delay(r.retryAfterSeconds * 1000)
          request--
          continue
        }
        if (r.kind === 'nothing') {
          if (progress.claimed === 0) throw new Error('Nothing left to claim on this market — refresh to update.')
          break
        }
        if (r.kind === 'pending') {
          // Which bets that tx covers isn't known here, and the relay holds the
          // claim lock until it expires, so stop after it confirms.
          await waitForPending(r.txHash)
          notice = 'Confirmed. If any bets still show as claimable, claim again in a minute.'
          break
        }

        markClaimed(marketAddress, r.betIds)
        txHash = r.txHashes[r.txHashes.length - 1]
        progress = { claimed: progress.claimed + r.betIds.length, total: progress.claimed + r.betIds.length + r.remainingCount }
        set({ step: 'confirming', txHash, progress })

        const inc = r.incomplete
        if (inc) {
          if (inc.error === 'SubmissionPending' && inc.txHash) {
            await waitForPending(inc.txHash)
            notice = 'Confirmed. If any bets still show as claimable, claim again in a minute.'
            break
          }
          if (inc.error === 'RelayBusy') {
            if (busyRetries++ >= MAX_BUSY_RETRIES) throw new RelayClaimError('Relay busy — try again in a few seconds.', txHash)
            await delay((inc.retryAfterSeconds ?? 5) * 1000)
            continue
          }
          if (RELAY_DOWN_ERRORS.has(inc.error)) {
            set({ step: 'needs_wallet', txHash, progress, notice: RELAY_UNAVAILABLE_MESSAGE })
            return
          }
          throw new RelayClaimError(inc.message, inc.txHash ?? txHash)
        }
        if (r.remainingCount === 0) break
      }
      set({ step: 'success', txHash, progress, notice })
    } catch (err) {
      console.error('claim failed:', err)
      // Keep any submitted txHash so the BaseScan link survives the error.
      const hash = (err instanceof RelayClaimError ? err.txHash : undefined) ?? txHash
      set({ step: 'error', error: describeError(err), txHash: hash, progress })
    }
  }

  function claimOne(bet: WalletBet) {
    const marketAddress = bet.market.marketAddress
    return runClaim(`${marketAddress}-${bet.betId}`, marketAddress, claimableByMarket.get(marketAddress) ?? [bet], {
      functionName: 'claimPayout',
      args: [bet.betId],
    })
  }

  function claimAll(marketAddress: string, marketBets: WalletBet[]) {
    return runClaim(`${marketAddress}-all`, marketAddress, marketBets, { functionName: 'claimAllPayouts' })
  }

  if (!isConnected) {
    return (
      <main className="max-w-2xl mx-auto px-4 py-20 text-center space-y-6">
        <div className="font-display text-7xl font-bold text-gold/20 leading-none select-none" aria-hidden>
          =
        </div>
        <h1 className="font-display text-3xl font-bold">My Bets</h1>
        <div className="space-y-4">
          <p className="text-white/60">Connect your wallet to view your bets.</p>
          <div className="flex justify-center">
            <ConnectWalletModal />
          </div>
        </div>
      </main>
    )
  }

  const hasAnyBets = bets.length > 0

  return (
    <main className="max-w-3xl mx-auto px-4 py-12 space-y-10">
      <header className="space-y-1">
        <h1 className="font-display text-3xl font-bold">My Bets</h1>
        {address && <YourPoints address={address} />}
        {loading && (
          <p className="text-xs text-white/40 tabular">
            Scanning markets… {scannedCount}/{totalCount}
          </p>
        )}
      </header>

      {errors.length > 0 && (
        <div className="rounded-md border border-red-400/30 bg-red-400/5 px-4 py-3 space-y-1">
          <p className="text-sm text-red-400 font-semibold">
            {errors.length === 1 ? "Couldn't load 1 market" : `Couldn't load ${errors.length} markets`}
          </p>
          {errors.map(({ market, message }) => (
            <p key={market.marketAddress} className="text-xs text-red-400/70">
              {market.parsedHome} vs {market.parsedAway}: {message}
            </p>
          ))}
          <p className="text-xs text-white/40 pt-1">
            This is separate from &quot;no bets found&quot; — bets on these markets may exist but couldn&apos;t be checked. Try refreshing.
          </p>
        </div>
      )}

      {markets === null ? (
        <p className="text-center text-white/40 text-sm py-12">Loading markets…</p>
      ) : !hasAnyBets && !loading && errors.length === 0 ? (
        <div className="text-center py-16 space-y-4">
          <p className="text-white/50">No bets found for this wallet.</p>
          <Link href="/" className="btn-ghost text-sm inline-flex">
            ← Browse markets
          </Link>
        </div>
      ) : !hasAnyBets && !loading && errors.length > 0 ? null : (
        <>
          <Section title="Active" show={active.length > 0 || loading}>
            {active.map(bet => (
              <ActiveBetCard key={`${bet.market.marketAddress}-${bet.betId}`} bet={bet} />
            ))}
            {active.length === 0 && !loading && <EmptySection text="No open bets." />}
          </Section>

          <Section title="Awaiting settlement" show={awaiting.length > 0}>
            {awaiting.map(bet => (
              <AwaitingBetCard key={`${bet.market.marketAddress}-${bet.betId}`} bet={bet} />
            ))}
          </Section>

          <Section title="Claimable" show={claimable.length > 0}>
            {[...claimableByMarket.entries()].map(([marketAddress, marketBets]) =>
              marketBets.length > 1 ? (
                <div key={`${marketAddress}-all-claim`} className="flex justify-end mb-1">
                  <ClaimAllButton
                    marketBets={marketBets}
                    state={claimStateFor(`${marketAddress}-all`, marketAddress)}
                    onClaim={() => claimAll(marketAddress, marketBets)}
                  />
                </div>
              ) : null
            )}
            {claimable.map(bet => (
              <ClaimableBetCard
                key={`${bet.market.marketAddress}-${bet.betId}`}
                bet={bet}
                state={claimStateFor(`${bet.market.marketAddress}-${bet.betId}`, bet.market.marketAddress)}
                onClaim={() => claimOne(bet)}
              />
            ))}
          </Section>

          <Section title="History" show={history.length > 0}>
            {history.map(bet => (
              <HistoryBetCard key={`${bet.market.marketAddress}-${bet.betId}`} bet={bet} />
            ))}
          </Section>
        </>
      )}
    </main>
  )
}

interface PointsSummary {
  total: number
  betPoints: number
  referralPoints: number
  rank: number | null
}

function YourPoints({ address }: { address: string }) {
  const [points, setPoints] = useState<PointsSummary | null>(null)
  useEffect(() => {
    let cancelled = false
    setPoints(null)
    fetch(`/api/points?address=${address}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data: PointsSummary | null) => {
        if (!cancelled) setPoints(data)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [address])

  if (!points) return null
  return (
    <p className="text-sm text-white/60 tabular">
      Your points: <span className="text-gold font-semibold">{points.total.toLocaleString('en-US')}</span>
      <span className="text-white/35">
        {' '}· {points.betPoints.toLocaleString('en-US')} from bets, {points.referralPoints.toLocaleString('en-US')} from referrals
        {points.rank !== null && ` · #${points.rank}`}
      </span>{' '}
      <Link href="/points" className="text-xs text-gold/80 underline underline-offset-2">
        Leaderboard
      </Link>
    </p>
  )
}

function Section({ title, show, children }: { title: string; show: boolean; children: React.ReactNode }) {
  if (!show) return null
  return (
    <section className="space-y-3">
      <div className="eq-divider text-xs" aria-hidden>
        {title}
      </div>
      <div className="space-y-3">{children}</div>
    </section>
  )
}

function EmptySection({ text }: { text: string }) {
  return <p className="text-sm text-white/30 text-center py-4">{text}</p>
}

function MatchupLine({ bet }: { bet: WalletBet }) {
  return (
    <p className="text-xs text-white/40 uppercase tracking-widest font-display">
      {bet.market.parsedHome} vs {bet.market.parsedAway}
    </p>
  )
}

function ActiveBetCard({ bet }: { bet: WalletBet }) {
  const side = betSide(bet)
  return (
    <div className="ticket p-4 space-y-2">
      <MatchupLine bet={bet} />
      <p className="text-sm text-white/85 leading-relaxed">{lineSentence(bet.lockedZ, side, bet.market.parsedHome, bet.market.parsedAway)}</p>
      <div className="flex justify-between text-xs text-white/50 tabular">
        <span>Stake: {formatUsdc(bet.stake)} USDC</span>
        <span>
          Current line: <span className="text-white/70">{formatSpread(bet.currentZ, side)}</span>
        </span>
      </div>
      <div className="pt-1">
        <ShareButton
          text={`I locked ${side === 'home' ? bet.market.parsedHome : bet.market.parsedAway} ${formatSpread(bet.lockedZ, side)} on Even Steven. Tail or fade?`}
          path={`/bet/${bet.market.marketAddress}/${bet.betId}`}
        />
      </div>
    </div>
  )
}

function AwaitingBetCard({ bet }: { bet: WalletBet }) {
  const side = betSide(bet)
  return (
    <div className="ticket p-4 space-y-2">
      <MatchupLine bet={bet} />
      <p className="text-sm text-white/85 leading-relaxed">{lineSentence(bet.lockedZ, side, bet.market.parsedHome, bet.market.parsedAway)}</p>
      <p className="text-xs text-white/50 tabular">Stake: {formatUsdc(bet.stake)} USDC</p>
      <p className="text-xs text-gold/70">Result submitted to UMA&apos;s oracle — payouts open in ~2 hours.</p>
    </div>
  )
}

function progressLabel(state: ClaimState | undefined): string {
  const p = state?.progress
  return p && p.total > 1 ? `Claiming… ${p.claimed}/${p.total}` : 'Claiming…'
}

function ClaimableBetCard({
  bet,
  state,
  onClaim,
}: {
  bet: WalletBet
  state: ClaimState | undefined
  onClaim: () => void
}) {
  const side = betSide(bet)
  const step = state?.step ?? 'idle'
  const busy = step === 'awaiting_signature' || step === 'confirming'

  return (
    <div className="ticket p-4 space-y-2 border-gold/30">
      <MatchupLine bet={bet} />
      <p className="text-sm text-white/85 leading-relaxed">{lineSentence(bet.lockedZ, side, bet.market.parsedHome, bet.market.parsedAway)}</p>
      <div className="flex items-center justify-between gap-3">
        <div className="text-xs text-white/50 tabular">
          <p>Stake: {formatUsdc(bet.stake)} USDC</p>
          <p className="text-win font-semibold text-sm mt-0.5">Payout: {formatUsdc(bet.payout)} USDC</p>
        </div>
        {step === 'success' ? (
          <span className="text-xs text-win">Claimed ✓</span>
        ) : (
          <button type="button" onClick={onClaim} disabled={busy} className="btn-gold text-xs px-4 py-2">
            {step === 'awaiting_signature'
              ? 'Confirm in wallet…'
              : step === 'confirming'
                ? progressLabel(state)
                : step === 'needs_wallet'
                  ? 'Claim with wallet'
                  : 'Claim'}
          </button>
        )}
      </div>
      {state?.notice && <p className="text-xs text-amber-400">{state.notice}</p>}
      {step === 'error' && state?.error && <p className="text-xs text-red-400">{state.error}</p>}
      {state?.txHash && (
        <a
          href={`${BASESCAN_URL}/tx/${state.txHash}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-gold underline underline-offset-2"
        >
          View transaction on BaseScan →
        </a>
      )}
    </div>
  )
}

function ClaimAllButton({
  marketBets,
  state,
  onClaim,
}: {
  marketBets: WalletBet[]
  state: ClaimState | undefined
  onClaim: () => void
}) {
  const step = state?.step ?? 'idle'
  const busy = step === 'awaiting_signature' || step === 'confirming'
  if (step === 'success') return null
  const total = formatUsdc(marketBets.reduce((sum, b) => sum + b.payout, BigInt(0)))

  return (
    <div className="flex flex-col items-end gap-1">
      <button type="button" onClick={onClaim} disabled={busy} className="btn-ghost text-xs px-4 py-2">
        {step === 'awaiting_signature'
          ? 'Confirm in wallet…'
          : busy
            ? progressLabel(state)
            : step === 'needs_wallet'
              ? `Claim all with wallet — ${total} USDC`
              : `Claim all (${marketBets.length}) — ${total} USDC`}
      </button>
      {state?.notice && <p className="text-xs text-amber-400">{state.notice}</p>}
      {step === 'error' && state?.error && <p className="text-xs text-red-400">{state.error}</p>}
      {state?.txHash && (
        <a
          href={`${BASESCAN_URL}/tx/${state.txHash}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-gold underline underline-offset-2"
        >
          View transaction on BaseScan →
        </a>
      )}
    </div>
  )
}

function HistoryBetCard({ bet }: { bet: WalletBet }) {
  const side = betSide(bet)
  const won = bet.status === 'won'
  const lost = bet.status === 'lost'
  const refunded = bet.status === 'refunded'

  return (
    <div className="ticket p-4 space-y-2 opacity-90">
      <MatchupLine bet={bet} />
      <p className="text-sm text-white/70 leading-relaxed">{lineSentence(bet.lockedZ, side, bet.market.parsedHome, bet.market.parsedAway)}</p>
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-white/40 tabular">Stake: {formatUsdc(bet.stake)} USDC</p>
        <p className={['text-sm font-semibold tabular', won ? 'text-win' : lost ? 'text-white/35' : 'text-white/60'].join(' ')}>
          {won && `Won · ${formatUsdc(bet.payout)} USDC`}
          {lost && 'Lost · $0.00'}
          {refunded && `Refunded · ${formatUsdc(bet.payout)} USDC`}
        </p>
      </div>
      {won && (
        <div className="pt-1">
          <ShareButton
            text={`I won ${formatUsdc(bet.payout)} USDC on ${side === 'home' ? bet.market.parsedHome : bet.market.parsedAway} ${formatSpread(bet.lockedZ, side)} on Even Steven.`}
            path={`/bet/${bet.market.marketAddress}/${bet.betId}`}
          />
        </div>
      )}
    </div>
  )
}
