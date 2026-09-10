import { NextRequest, NextResponse } from 'next/server'
import { getAddress } from 'viem'
import { exact } from 'x402/schemes'
import { findMatchingPaymentRequirements, processPriceToAtomicAmount } from 'x402/shared'
import { useFacilitator } from 'x402/verify'
import type { Network, PaymentRequirements, Price } from 'x402/types'

// Inline x402 enforcement for App Router route handlers. Route handlers run
// in the Node.js runtime (not Edge) by default, so — unlike middleware.ts,
// which Next.js always bundles for the Edge Runtime and its 1 MB size limit —
// this avoids pulling x402-next's bundled paymentMiddleware (and its
// @coinbase/cdp-sdk/axios dependency chain) into an Edge bundle at all.

const X402_VERSION = 1
const NETWORK: Network = 'base'

function getPayTo(): `0x${string}` {
  const payTo = process.env.X402_RECEIVING_ADDRESS
  if (!payTo) throw new Error('X402_RECEIVING_ADDRESS is not set')
  return payTo as `0x${string}`
}

function getFacilitatorUrl(): `${string}://${string}` {
  return (process.env.X402_FACILITATOR_URL ?? 'https://x402.org/facilitator') as `${string}://${string}`
}

async function buildPaymentRequirements(
  price: Price,
  resourceUrl: string,
  description: string
): Promise<PaymentRequirements[]> {
  const atomicAmount = processPriceToAtomicAmount(price, NETWORK)
  if ('error' in atomicAmount) throw new Error(atomicAmount.error)
  const { maxAmountRequired, asset } = atomicAmount

  return [
    {
      scheme: 'exact',
      network: NETWORK,
      maxAmountRequired,
      resource: resourceUrl,
      description,
      mimeType: 'application/json',
      payTo: getAddress(getPayTo()),
      maxTimeoutSeconds: 300,
      asset: getAddress(asset.address),
      extra: 'eip712' in asset ? asset.eip712 : undefined,
    },
  ]
}

function paymentRequired(paymentRequirements: PaymentRequirements[], error: string) {
  return NextResponse.json({ x402Version: X402_VERSION, error, accepts: paymentRequirements }, { status: 402 })
}

/**
 * Guards an x402-priced route. Call at the top of the handler with the
 * USDC price (e.g. '$0.05') and a short description of the resource.
 *
 * Returns a 402 NextResponse when payment is missing, invalid, or fails to
 * settle against the configured facilitator. Returns null when the payment
 * has been verified AND settled — the caller should proceed and return its
 * normal response. Because settlement happens here, before the handler's
 * own logic runs, a request that later 400/404/409s inside the handler
 * (e.g. an unknown gameId) still consumes the payment.
 */
export async function requirePayment(
  request: NextRequest,
  price: Price,
  description: string
): Promise<NextResponse | null> {
  const { verify, settle } = useFacilitator({ url: getFacilitatorUrl() })
  const resourceUrl = request.nextUrl.toString()
  const paymentRequirements = await buildPaymentRequirements(price, resourceUrl, description)

  const paymentHeader = request.headers.get('X-PAYMENT')
  if (!paymentHeader) {
    return paymentRequired(paymentRequirements, 'X-PAYMENT header is required')
  }

  let decodedPayment
  try {
    decodedPayment = exact.evm.decodePayment(paymentHeader)
    decodedPayment.x402Version = X402_VERSION
  } catch (err) {
    return paymentRequired(paymentRequirements, err instanceof Error ? err.message : 'Invalid payment')
  }

  const selectedRequirements = findMatchingPaymentRequirements(paymentRequirements, decodedPayment)
  if (!selectedRequirements) {
    return paymentRequired(paymentRequirements, 'Unable to find matching payment requirements')
  }

  const verification = await verify(decodedPayment, selectedRequirements)
  if (!verification.isValid) {
    return paymentRequired(paymentRequirements, verification.invalidReason ?? 'Payment verification failed')
  }

  const settlement = await settle(decodedPayment, selectedRequirements)
  if (!settlement.success) {
    return paymentRequired(paymentRequirements, settlement.errorReason ?? 'Failed to settle payment')
  }

  return null
}
