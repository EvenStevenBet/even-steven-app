'use client'

import { useEffect, useState } from 'react'
import { BaseError, formatUnits, parseUnits } from 'viem'
import { useAccount, useConnect, usePublicClient, useReadContract, useWriteContract } from 'wagmi'
import { USDC_ADDRESS, BASESCAN_URL } from '@/lib/chain'
import { marketAbi, erc20Abi } from '@/lib/contracts'

const MIN_STAKE = BigInt(1_000_000) // 1 USDC, 6 decimals
const FEE_BPS = BigInt(200)         // 2% — matches FEE_PERCENT on-chain (CLAUDE.md)

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
}

type Step =
  | 'idle'
  | 'awaiting_approval_signature'
  | 'confirming_approval'
  | 'awaiting_bet_signature'
  | 'confirming_bet'
  | 'success'
  | 'error'

const STEP_LABEL: Record<Step, string> = {
  idle: '',
  awaiting_approval_signature: 'Confirm the USDC approval in your wallet…',
  confirming_approval: 'Approval submitted — waiting for confirmation…',
  awaiting_bet_signature: 'Confirm the bet in your wallet…',
  confirming_bet: 'Bet submitted — waiting for confirmation…',
  success: 'Bet placed.',
  error: 'Something went wrong.',
}

// Debounced so simulatePayout/getMarketEV don't refetch on every keystroke.
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

function fmtUsdc(raw: bigint | undefined): string {
  if (raw === undefined) return '—'
  return Number(formatUnits(raw, 6)).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

export function BetSlip({ marketAddress, homeTeam, awayTeam }: Props) {
  const { address, isConnected } = useAccount()
  const publicClient = usePublicClient()
  const { writeContractAsync } = useWriteContract()
  const { connect, connectors, isPending: isConnecting, error: connectError, variables: connectVariables } = useConnect()

  const [side, setSide] = useState<'home' | 'away' | null>(null)
  const [stakeInput, setStakeInput] = useState('')
  const [step, setStep] = useState<Step>('idle')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [successTxHash, setSuccessTxHash] = useState<`0x${string}` | null>(null)

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

  const { data: bettingOpen, isLoading: bettingOpenLoading } = useReadContract({
    address: marketAddress,
    abi: marketAbi,
    functionName: 'bettingOpen',
  })

  const { data: usdcBalance, refetch: refetchBalance } = useReadContract({
    address: USDC_ADDRESS,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    query: { enabled: Boolean(address) },
  })

  const simulateEnabled =
    side !== null && debouncedStake !== null && debouncedStake >= MIN_STAKE && bettingOpen === true

  const { data: estimatedPayout, isFetching: payoutLoading } = useReadContract({
    address: marketAddress,
    abi: marketAbi,
    functionName: 'simulatePayout',
    args: debouncedStake !== null && side !== null ? [debouncedStake, side === 'home'] : undefined,
    query: { enabled: simulateEnabled },
  })

  // Richer EV context (liquidPayout "at liquidity" figure, per CLAUDE.md naming).
  const { data: evData } = useReadContract({
    address: marketAddress,
    abi: marketAbi,
    functionName: 'getMarketEV',
    args: debouncedStake !== null && side !== null ? [debouncedStake, side === 'home'] : undefined,
    query: { enabled: simulateEnabled },
  })

  const insufficientBalance =
    Boolean(address) && usdcBalance !== undefined && totalCost !== null && usdcBalance < totalCost

  const busy =
    step === 'awaiting_approval_signature' ||
    step === 'confirming_approval' ||
    step === 'awaiting_bet_signature' ||
    step === 'confirming_bet'

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
  }

  async function handleSubmit() {
    if (!address || !publicClient || stakeBigInt === null || totalCost === null || side === null) return
    setErrorMessage(null)
    setSuccessTxHash(null)

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
          args: [marketAddress, totalCost],
          account: address,
        })
        const approveHash = await writeContractAsync({
          address: USDC_ADDRESS,
          abi: erc20Abi,
          functionName: 'approve',
          args: [marketAddress, totalCost],
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

      setSuccessTxHash(betHash)
      setStep('success')
      refetchBalance()
    } catch (err) {
      console.error('placeBet failed:', err)
      setStep('error')
      setErrorMessage(describeError(err))
    }
  }

  if (bettingOpenLoading) {
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

  return (
    <div className="ticket p-6 space-y-5">
      <div className="eq-divider text-xs" aria-hidden>bet slip</div>

      {/* Side selection */}
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() => setSide('home')}
          disabled={busy}
          className={[
            'py-3 px-2 rounded-md border text-sm font-display font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed',
            side === 'home' ? 'border-gold bg-gold/10 text-gold' : 'border-white/10 text-white/70 hover:border-white/30',
          ].join(' ')}
        >
          {homeTeam}
        </button>
        <button
          type="button"
          onClick={() => setSide('away')}
          disabled={busy}
          className={[
            'py-3 px-2 rounded-md border text-sm font-display font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed',
            side === 'away' ? 'border-gold bg-gold/10 text-gold' : 'border-white/10 text-white/70 hover:border-white/30',
          ].join(' ')}
        >
          {awayTeam}
          <span className="block text-[10px] font-normal text-white/40 mt-0.5">or tie</span>
        </button>
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
          <p className="mt-1 text-xs text-red-400">
            Insufficient USDC balance ({fmtUsdc(usdcBalance)} available).
          </p>
        )}
      </div>

      {/* Cost breakdown */}
      {stakeBigInt !== null && !belowMinimum && (
        <div className="text-xs text-white/50 space-y-1 tabular">
          <div className="flex justify-between">
            <span>Stake</span>
            <span>{fmtUsdc(stakeBigInt)} USDC</span>
          </div>
          <div className="flex justify-between">
            <span>Fee (2%)</span>
            <span>{fmtUsdc(fee ?? undefined)} USDC</span>
          </div>
          <div className="flex justify-between text-white/80 font-semibold">
            <span>Total to approve</span>
            <span>{fmtUsdc(totalCost ?? undefined)} USDC</span>
          </div>
        </div>
      )}

      {/* Payout estimate — always from the contract, never computed here */}
      {side !== null && stakeBigInt !== null && !belowMinimum && (
        <div className="rounded-md border border-gold/20 bg-gold/5 px-3 py-2.5">
          <p className="text-[10px] text-white/40 uppercase tracking-widest font-display">Estimated payout</p>
          {payoutLoading ? (
            <p className="text-sm text-white/40 mt-0.5">Calculating…</p>
          ) : estimatedPayout !== undefined ? (
            <>
              <p className="text-xl font-display font-bold text-gold tabular mt-0.5">
                {fmtUsdc(estimatedPayout)} USDC
              </p>
              {evData !== undefined && (
                <p className="text-xs text-white/40 mt-0.5 tabular">{fmtUsdc(evData[1])} USDC at liquidity</p>
              )}
            </>
          ) : (
            <p className="text-sm text-white/40 mt-0.5">—</p>
          )}
        </div>
      )}

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
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!canSubmit}
          className="btn-gold w-full"
        >
          {busy ? STEP_LABEL[step] : 'Place bet'}
        </button>
      )}
    </div>
  )
}
