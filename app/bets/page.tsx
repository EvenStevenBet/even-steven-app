'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { BaseError } from 'viem'
import { useAccount, usePublicClient, useWriteContract } from 'wagmi'
import { ConnectWalletModal } from '@/components/ConnectWalletModal'
import { BASESCAN_URL } from '@/lib/chain'
import { marketAbi } from '@/lib/contracts'
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

type RelayClaim =
  | { kind: 'claimed'; txHash: `0x${string}`; betIds: bigint[] }
  | { kind: 'pending'; txHash: `0x${string}` }
  | { kind: 'unsupported' }
  | { kind: 'unavailable' }

// How long to wait for a relayed claim the route answered 504 SubmissionPending
// for (it already waited 15s). A dropped tx then errors instead of hanging.
const PENDING_CLAIM_TIMEOUT_MS = 120_000
const RELAY_UNAVAILABLE_MESSAGE = "Relay unavailable — you'll need ETH in your wallet to claim."

// A relay error that still carries a submitted tx (SubmissionReverted,
// CustodyInvariantViolated), so the BaseScan link survives into the error state.
class RelayClaimError extends Error {
  constructor(message: string, readonly txHash?: `0x${string}`) {
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
    if (!data.txHash) throw new Error('Nothing left to claim on this market — refresh to update.')
    return { kind: 'claimed', txHash: data.txHash, betIds: (data.betIds as string[]).map(id => BigInt(id)) }
  }
  if (res.status === 504 && data.txHash) return { kind: 'pending', txHash: data.txHash }
  if (data.error === 'UnsupportedMarket') return { kind: 'unsupported' }
  if (res.status === 503) return { kind: 'unavailable' }
  if (res.status === 429) throw new Error('Too many claim requests — wait a minute and try again.')
  throw new RelayClaimError(data.message ?? `Claim failed (HTTP ${res.status}).`, data.txHash)
}

type ClaimStep = 'idle' | 'relay_unavailable' | 'awaiting_signature' | 'confirming' | 'success' | 'error'
interface ClaimState {
  step: ClaimStep
  txHash?: `0x${string}`
  error?: string
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

  // Claims go through the relay (POST /api/claim): the wallet only identifies
  // the bettor, signs nothing and needs no ETH. The relay claims every bet the
  // bettor is owed on the market in one claimPayoutFor. Markets older than
  // Factory v1.6 have no claimPayoutFor and fall back to the wallet claiming
  // directly. A 503 (relay submitted nothing) never falls back silently: the
  // user is told they'll pay gas and must click again to claim from the wallet.
  async function runClaim(
    key: string,
    marketAddress: string,
    marketBets: WalletBet[],
    walletCall: { functionName: 'claimPayout'; args: [bigint] } | { functionName: 'claimAllPayouts' }
  ) {
    if (!publicClient || !address) return
    const viaWallet = claimStates[key]?.step === 'relay_unavailable'
    setClaimStates(prev => ({ ...prev, [key]: { step: 'confirming' } }))
    try {
      const relayed: RelayClaim = viaWallet ? { kind: 'unsupported' } : await relayClaim(marketAddress, address)
      if (relayed.kind === 'unavailable') {
        setClaimStates(prev => ({ ...prev, [key]: { step: 'relay_unavailable' } }))
        return
      }
      let hash: `0x${string}`
      let claimedIds = marketBets.map(b => b.betId)
      if (relayed.kind === 'unsupported') {
        setClaimStates(prev => ({ ...prev, [key]: { step: 'awaiting_signature' } }))
        const addr = marketAddress as `0x${string}`
        const gas = await publicClient.estimateContractGas({
          address: addr,
          abi: marketAbi,
          ...walletCall,
          account: address,
          dataSuffix: attributionSuffix(),
        })
        hash = await writeContractAsync({
          address: addr,
          abi: marketAbi,
          ...walletCall,
          gas: (gas * BigInt(120)) / BigInt(100),
          dataSuffix: attributionSuffix(),
        })
        setClaimStates(prev => ({ ...prev, [key]: { step: 'confirming', txHash: hash } }))
        const receipt = await publicClient.waitForTransactionReceipt({ hash })
        if (receipt.status !== 'success') throw new Error(`${walletCall.functionName} transaction reverted on-chain.`)
      } else {
        hash = relayed.txHash
        if (relayed.kind === 'claimed') {
          claimedIds = relayed.betIds
        } else {
          // Submitted but not mined within the route's window — wait it out here.
          setClaimStates(prev => ({ ...prev, [key]: { step: 'confirming', txHash: hash } }))
          const receipt = await publicClient
            .waitForTransactionReceipt({ hash, timeout: PENDING_CLAIM_TIMEOUT_MS })
            .catch(() => {
              throw new Error('Claim not confirmed after 2 minutes and may have been dropped. Check BaseScan, then try again.')
            })
          if (receipt.status !== 'success') throw new Error('Claim transaction reverted on-chain.')
        }
      }
      setClaimStates(prev => ({ ...prev, [key]: { step: 'success', txHash: hash } }))
      markClaimed(marketAddress, claimedIds)
    } catch (err) {
      console.error('claim failed:', err)
      // Keep any submitted txHash so the BaseScan link survives the error.
      const txHash = err instanceof RelayClaimError ? err.txHash : undefined
      setClaimStates(prev => ({
        ...prev,
        [key]: { step: 'error', error: describeError(err), txHash: txHash ?? prev[key]?.txHash },
      }))
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
                    state={claimStates[`${marketAddress}-all`]}
                    onClaim={() => claimAll(marketAddress, marketBets)}
                  />
                </div>
              ) : null
            )}
            {claimable.map(bet => (
              <ClaimableBetCard
                key={`${bet.market.marketAddress}-${bet.betId}`}
                bet={bet}
                state={claimStates[`${bet.market.marketAddress}-${bet.betId}`]}
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
                ? 'Claiming…'
                : step === 'relay_unavailable'
                  ? 'Claim with wallet'
                  : 'Claim'}
          </button>
        )}
      </div>
      {step === 'relay_unavailable' && <p className="text-xs text-amber-400">{RELAY_UNAVAILABLE_MESSAGE}</p>}
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
        {busy
          ? 'Claiming all…'
          : step === 'relay_unavailable'
            ? `Claim all with wallet — ${total} USDC`
            : `Claim all (${marketBets.length}) — ${total} USDC`}
      </button>
      {step === 'relay_unavailable' && <p className="text-xs text-amber-400">{RELAY_UNAVAILABLE_MESSAGE}</p>}
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
