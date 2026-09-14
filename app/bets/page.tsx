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

function describeError(err: unknown): string {
  if (err instanceof BaseError) return err.shortMessage
  return err instanceof Error ? err.message : 'Something went wrong.'
}

function betSide(bet: WalletBet): Side {
  return bet.side
}

type ClaimStep = 'idle' | 'awaiting_signature' | 'confirming' | 'success' | 'error'
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

  async function claimOne(bet: WalletBet) {
    if (!publicClient) return
    const key = `${bet.market.marketAddress}-${bet.betId}`
    setClaimStates(prev => ({ ...prev, [key]: { step: 'awaiting_signature' } }))
    try {
      const marketAddress = bet.market.marketAddress as `0x${string}`
      const gas = await publicClient.estimateContractGas({
        address: marketAddress,
        abi: marketAbi,
        functionName: 'claimPayout',
        args: [bet.betId],
        account: address,
      })
      const hash = await writeContractAsync({
        address: marketAddress,
        abi: marketAbi,
        functionName: 'claimPayout',
        args: [bet.betId],
        gas: (gas * BigInt(120)) / BigInt(100),
      })
      setClaimStates(prev => ({ ...prev, [key]: { step: 'confirming', txHash: hash } }))
      const receipt = await publicClient.waitForTransactionReceipt({ hash })
      if (receipt.status !== 'success') throw new Error('claimPayout transaction reverted on-chain.')
      setClaimStates(prev => ({ ...prev, [key]: { step: 'success', txHash: hash } }))
      markClaimed(bet.market.marketAddress, [bet.betId])
    } catch (err) {
      console.error('claimPayout failed:', err)
      setClaimStates(prev => ({ ...prev, [key]: { step: 'error', error: describeError(err) } }))
    }
  }

  async function claimAll(marketAddress: string, marketBets: WalletBet[]) {
    if (!publicClient) return
    const key = `${marketAddress}-all`
    setClaimStates(prev => ({ ...prev, [key]: { step: 'awaiting_signature' } }))
    try {
      const addr = marketAddress as `0x${string}`
      const gas = await publicClient.estimateContractGas({
        address: addr,
        abi: marketAbi,
        functionName: 'claimAllPayouts',
        account: address,
      })
      const hash = await writeContractAsync({
        address: addr,
        abi: marketAbi,
        functionName: 'claimAllPayouts',
        gas: (gas * BigInt(120)) / BigInt(100),
      })
      setClaimStates(prev => ({ ...prev, [key]: { step: 'confirming', txHash: hash } }))
      const receipt = await publicClient.waitForTransactionReceipt({ hash })
      if (receipt.status !== 'success') throw new Error('claimAllPayouts transaction reverted on-chain.')
      setClaimStates(prev => ({ ...prev, [key]: { step: 'success', txHash: hash } }))
      markClaimed(marketAddress, marketBets.map(b => b.betId))
    } catch (err) {
      console.error('claimAllPayouts failed:', err)
      setClaimStates(prev => ({ ...prev, [key]: { step: 'error', error: describeError(err) } }))
    }
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
            {step === 'awaiting_signature' ? 'Confirm in wallet…' : step === 'confirming' ? 'Claiming…' : 'Claim'}
          </button>
        )}
      </div>
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

  return (
    <button type="button" onClick={onClaim} disabled={busy} className="btn-ghost text-xs px-4 py-2">
      {busy
        ? 'Claiming all…'
        : `Claim all (${marketBets.length}) — ${formatUsdc(marketBets.reduce((sum, b) => sum + b.payout, BigInt(0)))} USDC`}
    </button>
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
            path={`/market/${bet.market.gameId}`}
          />
        </div>
      )}
    </div>
  )
}
