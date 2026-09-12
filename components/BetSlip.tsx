'use client'

import { useEffect, useState } from 'react'
import { BaseError, decodeEventLog, encodeFunctionData, parseUnits } from 'viem'
import {
  useAccount,
  useCallsStatus,
  useConnect,
  usePublicClient,
  useReadContract,
  useSendCalls,
  useWriteContract,
} from 'wagmi'
import { USDC_ADDRESS, BASESCAN_URL } from '@/lib/chain'
import { marketAbi, erc20Abi } from '@/lib/contracts'
import { useIsSmartWallet } from '@/lib/useSmartWallet'
import { formatStakeToPayout, formatUsdc } from '@/lib/format'
import { favoriteHeadline, formatSpread, lineSentence, outcomeText } from '@/lib/line'
import type { Side } from '@/lib/line'
import { isFirstMoverMarket, stakedPool } from '@/lib/pool'
import { Countdown } from '@/components/Countdown'
import { FirstMoverBadge } from '@/components/FirstMoverBadge'

const MIN_STAKE = BigInt(1_000_000) // 1 USDC, 6 decimals
const FEE_BPS = BigInt(200)         // 2% — matches FEE_PERCENT on-chain (CLAUDE.md)
// Same reference stake the x402 agent endpoint quotes at, so a human reading
// the slip and an agent reading /api/markets/agent see identical numbers.
const REFERENCE_STAKE = BigInt(100_000_000) // 100 USDC
// The line moves on other people's bets, not just the reader's typing, so a
// slip left sitting open goes stale on its own. Poll while betting is open.
// Human-UI only: agents read getMarketEV directly before every bet.
const POLL_MS = 15_000
// Circle USDC on Base requires max approval — exact amounts fail intermittently (CLAUDE.md).
const MAX_UINT256 = (BigInt(1) << BigInt(256)) - BigInt(1)

// Turning a dead end into a step: both destinations verified to resolve.
const BRIDGE_URL = 'https://bridge.base.org/deposit'
const SWAP_URL = `https://app.uniswap.org/swap?chain=base&outputCurrency=${USDC_ADDRESS}`

// Wallets' built-in gas estimation has been observed returning wildly
// inflated values (~140M gas, near a full block) for these calls, which RPC
// providers reject outright before broadcast. Estimate for real via
// publicClient.estimateContractGas and pass an explicit, buffered value
// instead of trusting the wallet's own default estimation path.
const GAS_BUFFER_NUMERATOR = BigInt(120)
const GAS_BUFFER_DENOMINATOR = BigInt(100)
function withGasBuffer(gas: bigint): bigint {
  return (gas * GAS_BUFFER_NUMERATOR) / GAS_BUFFER_DENOMINATOR
}

interface Props {
  marketAddress: `0x${string}`
  homeTeam: string
  awayTeam: string
  /** Kickoff from the market CSV's gameDate column — drives the close countdown. */
  closesAt?: string
}

type Step =
  | 'idle'
  | 'awaiting_approval_signature'
  | 'confirming_approval'
  | 'awaiting_bet_signature'
  | 'confirming_bet'
  | 'awaiting_batch_signature'
  | 'confirming_batch'
  | 'success'
  | 'error'

const STEP_LABEL: Record<Step, string> = {
  idle: '',
  awaiting_approval_signature: 'Confirm the USDC approval in your wallet…',
  confirming_approval: 'Approval submitted — waiting for confirmation…',
  awaiting_bet_signature: 'Confirm the bet in your wallet…',
  confirming_bet: 'Bet submitted — waiting for confirmation…',
  awaiting_batch_signature: 'Confirm the bet in your wallet…',
  confirming_batch: 'Confirming your bet…',
  success: 'Bet placed.',
  error: 'Something went wrong.',
}

// Debounced so the EV / market-state reads don't refetch on every keystroke —
// typing "1000" would otherwise fire four rounds of RPC calls.
function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(id)
  }, [value, delayMs])
  return debounced
}

// viem wraps wallet rejections and contract reverts in BaseError with a
// human-readable shortMessage (e.g. "User rejected the request.") — prefer
// that over guessing at raw RPC error strings.
function describeError(err: unknown): string {
  if (err instanceof BaseError) return err.shortMessage
  return err instanceof Error ? err.message : 'Something went wrong.'
}

// getMarketEV returns (currentPayout, liquidPayout, impliedVig).
type EvTuple = readonly [bigint, bigint, bigint]

export function BetSlip({ marketAddress, homeTeam, awayTeam, closesAt }: Props) {
  const { address, isConnected } = useAccount()
  const publicClient = usePublicClient()
  const { writeContractAsync } = useWriteContract()
  const { connect, connectors, isPending: isConnecting, error: connectError, variables: connectVariables } = useConnect()
  const isSmartWallet = useIsSmartWallet()
  const { sendCallsAsync } = useSendCalls()

  const [side, setSide] = useState<Side | null>(null)
  const [stakeInput, setStakeInput] = useState('')
  const [step, setStep] = useState<Step>('idle')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [successTxHash, setSuccessTxHash] = useState<`0x${string}` | null>(null)
  const [lockedZAtPlacement, setLockedZAtPlacement] = useState<bigint | null>(null)
  const [sideAtPlacement, setSideAtPlacement] = useState<Side | null>(null)
  const [pendingCallsId, setPendingCallsId] = useState<string | null>(null)

  // A different wallet connecting (or the same wallet reconnecting) should not
  // show the previous session's result. Also clears pendingCallsId so a
  // still-in-flight gasless batch from the old session can't resolve later and
  // flip step back to success/error out from under the new session — clearing
  // step/errorMessage/successTxHash alone isn't enough since useCallsStatus
  // below keeps polling on the stale id otherwise.
  useEffect(() => {
    setStep('idle')
    setErrorMessage(null)
    setSuccessTxHash(null)
    setLockedZAtPlacement(null)
    setSideAtPlacement(null)
    setPendingCallsId(null)
  }, [address])

  // Smart-wallet path only: poll the sendCalls bundle until its receipts land,
  // then pull the real tx hash out of them — sendCalls itself never returns one.
  const { data: callsStatus } = useCallsStatus({
    id: pendingCallsId ?? '',
    query: {
      enabled: pendingCallsId !== null,
      refetchInterval: (query) => (query.state.data?.status === 'pending' ? 1000 : false),
    },
  })

  let stakeBigInt: bigint | null = null
  let stakeParseError = false
  if (stakeInput.trim() !== '') {
    try {
      stakeBigInt = parseUnits(stakeInput.trim(), 6)
    } catch {
      stakeParseError = true
    }
  }
  const belowMinimum = stakeBigInt !== null && stakeBigInt < MIN_STAKE
  const fee = stakeBigInt !== null ? (stakeBigInt * FEE_BPS) / BigInt(10_000) : null
  const totalCost = stakeBigInt !== null && fee !== null ? stakeBigInt + fee : null

  const debouncedStake = useDebouncedValue(stakeBigInt, 350)
  const hasRealStake = debouncedStake !== null && debouncedStake >= MIN_STAKE
  // Pre-stake the buttons quote the 100 USDC reference; once a real stake is
  // entered every figure recomputes against it.
  const quoteStake = hasRealStake ? debouncedStake : REFERENCE_STAKE

  const {
    data: marketState,
    isLoading: marketStateLoading,
    refetch: refetchMarketState,
  } = useReadContract({
    address: marketAddress,
    abi: marketAbi,
    functionName: 'getMarketState',
    // Undefined on the very first render, so the market polls until it has told
    // us it is closed, then stops. react-query clears the timer on unmount.
    query: { refetchInterval: (query) => (query.state.data?.[5] === false ? false : POLL_MS) },
  })

  // getMarketState returns (gameId, z, gPool, lePool, tPool, isOpen, isSettled).
  const currentZ: bigint | undefined = marketState?.[1]
  const totalPool: bigint | undefined = marketState?.[4]
  const bettingOpen: boolean | undefined = marketState?.[5]

  // currentZ moves with every bet, so the line on screen goes stale while the
  // slip is open. Refetch it alongside the EV reads — on the debounced stake,
  // never on raw keystrokes.
  useEffect(() => {
    if (debouncedStake === null) return
    refetchMarketState()
  }, [debouncedStake, refetchMarketState])

  // Fixed at openMarket() and never written again, so it needs no polling —
  // but it is read rather than assumed, because the pool figure is only honest
  // if the seed being subtracted is the seed the contract actually holds.
  const { data: protocolSeedTotal } = useReadContract({
    address: marketAddress,
    abi: marketAbi,
    functionName: 'protocolSeedTotal',
    query: { staleTime: Infinity },
  })

  const staked =
    totalPool !== undefined && protocolSeedTotal !== undefined
      ? stakedPool(totalPool, protocolSeedTotal)
      : undefined
  const firstMover = isFirstMoverMarket(staked)

  const { data: usdcBalance, refetch: refetchBalance } = useReadContract({
    address: USDC_ADDRESS,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    query: { enabled: Boolean(address) },
  })

  // Both sides are quoted at all times — the symmetric payout is the product.
  // currentPayout here is the same expression simulatePayout() evaluates, so
  // one read per side covers both scenario figures.
  // quoteStake is the existing debounced value — polling reuses it rather than
  // tracking a stake of its own, so a poll tick and a keystroke can't disagree
  // about what is being quoted.
  const evEnabled = bettingOpen === true
  const evQuery = { enabled: evEnabled, refetchInterval: evEnabled ? POLL_MS : (false as const) }
  const { data: homeEv } = useReadContract({
    address: marketAddress,
    abi: marketAbi,
    functionName: 'getMarketEV',
    args: [quoteStake, true],
    query: evQuery,
  })
  const { data: awayEv } = useReadContract({
    address: marketAddress,
    abi: marketAbi,
    functionName: 'getMarketEV',
    args: [quoteStake, false],
    query: evQuery,
  })

  const evForSide = (s: Side): EvTuple | undefined => (s === 'home' ? homeEv : awayEv) as EvTuple | undefined
  const selectedEv = side !== null ? evForSide(side) : undefined

  const insufficientBalance =
    Boolean(address) && usdcBalance !== undefined && totalCost !== null && usdcBalance < totalCost

  const busy =
    step === 'awaiting_approval_signature' ||
    step === 'confirming_approval' ||
    step === 'awaiting_bet_signature' ||
    step === 'confirming_bet' ||
    step === 'awaiting_batch_signature' ||
    step === 'confirming_batch'

  const canSubmit =
    isConnected &&
    bettingOpen === true &&
    side !== null &&
    stakeBigInt !== null &&
    !belowMinimum &&
    !insufficientBalance &&
    !busy

  function resetForm() {
    setSide(null)
    setStakeInput('')
    setStep('idle')
    setErrorMessage(null)
    setSuccessTxHash(null)
    setLockedZAtPlacement(null)
    setSideAtPlacement(null)
    setPendingCallsId(null)
  }

  // Resolve the smart-wallet batch once its receipts land: pull the real
  // placeBet tx hash and lockedZ out of the receipts (sendCalls itself never
  // returns a tx hash — only a bundle id).
  useEffect(() => {
    if (pendingCallsId === null || !callsStatus) return

    if (callsStatus.status === 'success') {
      let txHash: `0x${string}` | undefined
      for (const receipt of callsStatus.receipts ?? []) {
        txHash = receipt.transactionHash
        for (const log of receipt.logs) {
          try {
            const decoded = decodeEventLog({
              abi: marketAbi,
              data: log.data,
              topics: log.topics as [`0x${string}`, ...`0x${string}`[]] | [],
              eventName: 'BetPlaced',
            })
            if (decoded.eventName === 'BetPlaced') {
              setLockedZAtPlacement(decoded.args.lockedZ)
            }
          } catch {
            // skip unrelated logs
          }
        }
      }
      if (txHash) setSuccessTxHash(txHash)
      setStep('success')
      setPendingCallsId(null)
      refetchBalance()
      refetchMarketState()
    } else if (callsStatus.status === 'failure') {
      setStep('error')
      setErrorMessage('Bet transaction failed on-chain.')
      setPendingCallsId(null)
    }
  }, [callsStatus, pendingCallsId, refetchBalance, refetchMarketState])

  async function handleSubmit() {
    if (!address || stakeBigInt === null || totalCost === null || side === null) return
    setErrorMessage(null)
    setSuccessTxHash(null)
    // Remembered because `side` is cleared on reset, and the confirmation has
    // to describe the bet that was actually placed.
    setSideAtPlacement(side)

    if (isSmartWallet) {
      try {
        setStep('awaiting_batch_signature')

        const approveCalldata = encodeFunctionData({
          abi: erc20Abi,
          functionName: 'approve',
          args: [marketAddress, MAX_UINT256],
        })
        const betCalldata = encodeFunctionData({
          abi: marketAbi,
          functionName: 'placeBet',
          args: [side === 'home', stakeBigInt],
        })
        const paymasterUrl = process.env.NEXT_PUBLIC_PAYMASTER_URL

        const { id } = await sendCallsAsync({
          calls: [
            { to: USDC_ADDRESS, data: approveCalldata },
            { to: marketAddress, data: betCalldata },
          ],
          ...(paymasterUrl ? { capabilities: { paymasterService: { url: paymasterUrl } } } : {}),
        })

        setStep('confirming_batch')
        setPendingCallsId(id)
      } catch (err) {
        console.error('sendCalls failed:', err)
        setStep('error')
        setErrorMessage(describeError(err))
      }
      return
    }

    if (!publicClient) return

    try {
      setStep('awaiting_approval_signature')

      // Skip a redundant approval if this address already approved enough
      // for this market — e.g. a retry after placeBet was rejected post-approval.
      const currentAllowance = await publicClient.readContract({
        address: USDC_ADDRESS,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [address, marketAddress],
      })

      if (currentAllowance < totalCost) {
        const approveGasEstimate = await publicClient.estimateContractGas({
          address: USDC_ADDRESS,
          abi: erc20Abi,
          functionName: 'approve',
          args: [marketAddress, MAX_UINT256],
          account: address,
        })
        const approveHash = await writeContractAsync({
          address: USDC_ADDRESS,
          abi: erc20Abi,
          functionName: 'approve',
          args: [marketAddress, MAX_UINT256],
          gas: withGasBuffer(approveGasEstimate),
        })
        setStep('confirming_approval')
        const approveReceipt = await publicClient.waitForTransactionReceipt({ hash: approveHash })
        if (approveReceipt.status !== 'success') {
          throw new Error('USDC approval transaction reverted on-chain.')
        }
      }

      setStep('awaiting_bet_signature')
      const betGasEstimate = await publicClient.estimateContractGas({
        address: marketAddress,
        abi: marketAbi,
        functionName: 'placeBet',
        args: [side === 'home', stakeBigInt],
        account: address,
      })
      const betHash = await writeContractAsync({
        address: marketAddress,
        abi: marketAbi,
        functionName: 'placeBet',
        args: [side === 'home', stakeBigInt],
        gas: withGasBuffer(betGasEstimate),
      })
      setStep('confirming_bet')
      const betReceipt = await publicClient.waitForTransactionReceipt({ hash: betHash })
      if (betReceipt.status !== 'success') {
        throw new Error('placeBet transaction reverted on-chain.')
      }

      // Decode lockedZ from the BetPlaced event in the receipt
      for (const log of betReceipt.logs) {
        try {
          const decoded = decodeEventLog({
            abi: marketAbi,
            data: log.data,
            topics: log.topics,
            eventName: 'BetPlaced',
          })
          if (decoded.eventName === 'BetPlaced') {
            setLockedZAtPlacement(decoded.args.lockedZ)
            break
          }
        } catch {
          // skip unrelated logs
        }
      }

      setSuccessTxHash(betHash)
      setStep('success')
      refetchBalance()
      refetchMarketState()
    } catch (err) {
      console.error('placeBet failed:', err)
      setStep('error')
      setErrorMessage(describeError(err))
    }
  }

  if (marketStateLoading) {
    return (
      <div className="ticket p-6 space-y-4">
        <div className="eq-divider text-xs" aria-hidden>bet slip</div>
        <p className="text-center text-white/40 text-sm py-4">Checking market status…</p>
      </div>
    )
  }

  if (bettingOpen === false) {
    return (
      <div className="ticket p-6 space-y-4">
        <div className="eq-divider text-xs" aria-hidden>bet slip</div>
        <p className="text-center text-white/50 text-sm py-4">Betting is closed for this market.</p>
      </div>
    )
  }

  const showBreakdown = stakeBigInt !== null && !belowMinimum && !stakeParseError

  return (
    <div className="ticket p-4 xs:p-6 space-y-5">
      <div className="eq-divider text-xs" aria-hidden>bet slip</div>

      {/* Who the line belongs to — a bare "−2" doesn't say whose −2 it is. */}
      <p className="text-center font-display text-base xs:text-lg font-bold tracking-wide text-gold">
        {currentZ === undefined ? 'Line loading…' : favoriteHeadline(currentZ, homeTeam, awayTeam)}
      </p>

      {firstMover && (
        <div className="flex justify-center">
          <FirstMoverBadge />
        </div>
      )}

      {/* Side selection — both sides quoted, so the symmetry is visible at a glance */}
      <div className="grid grid-cols-2 gap-2">
        <SideButton
          team={homeTeam}
          side="home"
          currentZ={currentZ}
          quoteStake={quoteStake}
          liquidPayout={(homeEv as EvTuple | undefined)?.[1]}
          selected={side === 'home'}
          disabled={busy}
          onSelect={() => setSide('home')}
        />
        <SideButton
          team={awayTeam}
          side="away"
          currentZ={currentZ}
          quoteStake={quoteStake}
          liquidPayout={(awayEv as EvTuple | undefined)?.[1]}
          selected={side === 'away'}
          disabled={busy}
          onSelect={() => setSide('away')}
        />
      </div>

      {/* Stake input */}
      <div>
        <label htmlFor="stake" className="text-xs text-white/50 uppercase tracking-widest font-display">
          Stake (USDC)
        </label>
        <input
          id="stake"
          type="text"
          inputMode="decimal"
          placeholder="0.00"
          value={stakeInput}
          disabled={busy}
          onChange={(e) => setStakeInput(e.target.value)}
          className="mt-1 w-full bg-white/5 border border-white/10 rounded-md px-3 py-2 text-lg tabular text-white focus:outline-none focus:border-gold/60 disabled:opacity-40"
        />
        {stakeParseError && <p className="mt-1 text-xs text-red-400">Enter a valid number.</p>}
        {!stakeParseError && belowMinimum && (
          <p className="mt-1 text-xs text-red-400">Minimum stake is 1 USDC.</p>
        )}
        {insufficientBalance && (
          <div className="mt-1 space-y-1">
            <p className="text-xs text-red-400">
              Insufficient USDC balance ({formatUsdc(usdcBalance)} available).
            </p>
            <p className="text-xs text-white/50">
              <a href={BRIDGE_URL} target="_blank" rel="noopener noreferrer" className="text-gold underline underline-offset-2">
                Bridge USDC to Base ↗
              </a>
              <span className="text-white/25"> · </span>
              <a href={SWAP_URL} target="_blank" rel="noopener noreferrer" className="text-gold underline underline-offset-2">
                Swap for USDC on Base ↗
              </a>
            </p>
          </div>
        )}
      </div>

      {/* Cost breakdown — the 2% fee appears here, once, and nowhere else. */}
      {showBreakdown && (
        <div className="text-xs text-white/50 space-y-1 tabular">
          <Row label="Stake" value={`${formatUsdc(stakeBigInt)} USDC`} />
          <Row label="Fee (2%)" value={`${formatUsdc(fee)} USDC`} />
          <Row label="Total to approve" value={`${formatUsdc(totalCost)} USDC`} emphasis />
        </div>
      )}

      {/* Two scenarios, not current-vs-aspirational. In a thin pool the first
          figure is legitimately near the stake because nobody has taken the
          other side yet — as a scenario that reads as the floor case, where
          labelling it "now" would make correct math look like a bad offer. */}
      {showBreakdown && side !== null && (
        <div className="rounded-md border border-gold/20 bg-gold/5 px-3 py-2.5 text-xs space-y-1 tabular">
          <Row
            label="If betting stopped now"
            value={`${formatUsdc(selectedEv?.[0])} USDC`}
            muted
          />
          <Row
            label="If the pool balances"
            value={`${formatUsdc(selectedEv?.[1])} USDC`}
            emphasis
          />
        </div>
      )}

      {/* A promise, not a risk: the line can't move against you — and the other
          half, because there is no cash-out and people arrive expecting one. */}
      {side !== null && currentZ !== undefined && (
        <p className="text-xs text-white/45 leading-relaxed">
          Your line locks at{' '}
          <span className="text-white/80 font-semibold tabular">{formatSpread(currentZ, side)}</span>{' '}
          when you confirm. Later bets can&apos;t move it, and you can&apos;t change it — there is no
          cash-out before the game settles.
        </p>
      )}

      {closesAt && <Countdown closesAt={closesAt} className="text-xs text-white/50 tabular" />}

      {/* Step / status messaging */}
      {step !== 'idle' && STEP_LABEL[step] && (
        <p
          className={[
            'text-sm',
            step === 'error' ? 'text-red-400' : step === 'success' ? 'text-gold' : 'text-white/60',
          ].join(' ')}
        >
          {STEP_LABEL[step]}
        </p>
      )}
      {step === 'error' && errorMessage && <p className="text-xs text-red-400/80">{errorMessage}</p>}

      {/* Confirmation quotes lockedZ from the receipt — the line the bet
          actually snapped at, which the current line may have already moved off. */}
      {lockedZAtPlacement !== null && sideAtPlacement !== null && (
        <div className="rounded-md border border-gold/30 bg-gold/5 px-3 py-2.5 space-y-1">
          <p className="text-[10px] text-white/40 uppercase tracking-widest font-display">Your line</p>
          <p className="text-sm text-white/85 leading-relaxed">
            {lineSentence(lockedZAtPlacement, sideAtPlacement, homeTeam, awayTeam)}.
          </p>
        </div>
      )}

      {step === 'success' && successTxHash && (
        <a
          href={`${BASESCAN_URL}/tx/${successTxHash}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-gold underline underline-offset-2"
        >
          View transaction on BaseScan →
        </a>
      )}

      {/* Submit / connect */}
      {!isConnected ? (
        <div className="space-y-2">
          <p className="text-xs text-white/50 uppercase tracking-widest font-display text-center">
            Connect a wallet
          </p>
          {connectors.map((connector) => {
            const isThisConnecting = isConnecting && connectVariables?.connector === connector
            return (
              <button
                key={connector.uid}
                type="button"
                onClick={() => connect({ connector })}
                disabled={isConnecting}
                className="w-full py-2.5 px-3 rounded-md border border-white/10 text-sm font-display font-semibold text-white/80 text-left transition-colors hover:border-gold/40 hover:text-gold disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {isThisConnecting ? `Connecting to ${connector.name}…` : connector.name}
              </button>
            )
          })}
          {connectError && (
            <p className="text-xs text-red-400 text-center">{describeError(connectError)}</p>
          )}
        </div>
      ) : step === 'success' ? (
        <button type="button" onClick={resetForm} className="btn-gold w-full">
          Place another bet
        </button>
      ) : (
        <div className="space-y-1.5">
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="btn-gold w-full"
          >
            {busy ? STEP_LABEL[step] : isSmartWallet ? 'Place bet (gasless)' : 'Place bet'}
          </button>
          {!isSmartWallet && (
            <p className="text-[10px] text-white/30 text-center">
              Connect a Coinbase Smart Wallet for one-tap gasless betting.
            </p>
          )}
        </div>
      )}
    </div>
  )
}

function Row({
  label,
  value,
  emphasis,
  muted,
}: {
  label: string
  value: string
  emphasis?: boolean
  muted?: boolean
}) {
  return (
    <div className={['flex justify-between gap-3', emphasis ? 'text-white/85 font-semibold' : muted ? 'text-white/45' : ''].join(' ')}>
      <span className="min-w-0">{label}</span>
      <span className="shrink-0">{value}</span>
    </div>
  )
}

function SideButton({
  team,
  side,
  currentZ,
  quoteStake,
  liquidPayout,
  selected,
  disabled,
  onSelect,
}: {
  team: string
  side: Side
  currentZ: bigint | undefined
  quoteStake: bigint
  liquidPayout: bigint | undefined
  selected: boolean
  disabled: boolean
  onSelect: () => void
}) {
  const quote = formatStakeToPayout(quoteStake, liquidPayout)

  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      aria-pressed={selected}
      className={[
        'flex flex-col gap-2 p-2.5 xs:p-3 rounded-md border text-left transition-colors',
        'disabled:opacity-40 disabled:cursor-not-allowed',
        selected ? 'border-gold bg-gold/10' : 'border-white/10 hover:border-white/30',
      ].join(' ')}
    >
      <span className="flex items-baseline justify-between gap-1.5 flex-wrap">
        <span
          className={[
            'font-display text-sm font-semibold leading-tight break-words',
            selected ? 'text-gold' : 'text-white/80',
          ].join(' ')}
        >
          {team}
        </span>
        <span className="font-display text-sm font-bold tabular shrink-0 text-gold">
          {currentZ === undefined ? '—' : formatSpread(currentZ, side)}
        </span>
      </span>

      {/* Derived from m = floor(z) + 1 on the raw contract integer — never from
          the rounded spread above, and never hardcoded. */}
      <span className="text-[11px] leading-snug text-white/55">
        {currentZ === undefined ? '…' : outcomeText(currentZ, side)}
      </span>

      {/* Payout at liquidity, quoted on the STAKE. Identical on both sides —
          that symmetry is the product, rendered as data. */}
      <span className="text-[11px] tabular text-white/70 leading-snug">
        <span className="whitespace-nowrap">{quote.stake}</span>{' '}
        <span className="whitespace-nowrap">{quote.payout}</span>
      </span>
    </button>
  )
}
