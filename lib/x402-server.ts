import { NextRequest, NextResponse } from 'next/server'
import { getAddress } from 'viem'
import { exact } from 'x402/schemes'
import { findMatchingPaymentRequirements, processPriceToAtomicAmount } from 'x402/shared'
import { useFacilitator } from 'x402/verify'
import { createFacilitatorConfig } from '@coinbase/x402'
import { settleResponseHeader } from 'x402/types'
import type { FacilitatorConfig, HTTPRequestStructure, Network, PaymentPayload, PaymentRequirements, Price, SettleResponse } from 'x402/types'

// Inline x402 enforcement for App Router route handlers. Route handlers run
// in the Node.js runtime (not Edge) by default, so — unlike middleware.ts,
// which Next.js always bundles for the Edge Runtime and its 1 MB size limit —
// this avoids pulling x402-next's bundled paymentMiddleware (and its
// @coinbase/cdp-sdk/axios dependency chain) into an Edge bundle at all.

const X402_VERSION = 1
const NETWORK: Network = process.env.NEXT_PUBLIC_CHAIN === 'baseSepolia' ? 'base-sepolia' : 'base'

// x402.org's public facilitator only settles base-sepolia; mainnet needs CDP.
// CDP rejects unauthenticated calls, and its JWTs are signed for exactly this
// host + path, so with keys present the URL is always CDP_FACILITATOR_URL.
const CDP_FACILITATOR_URL = 'https://api.cdp.coinbase.com/platform/v2/x402'
const X402_ORG_FACILITATOR_URL = 'https://x402.org/facilitator'

function getPayTo(): `0x${string}` {
  const payTo = process.env.X402_RECEIVING_ADDRESS
  if (!payTo) throw new Error('X402_RECEIVING_ADDRESS is not set')
  return payTo as `0x${string}`
}

let warnedUnauthenticatedCdp = false

/**
 * CDP_API_KEY_ID + CDP_API_KEY_SECRET set: the authenticated CDP facilitator,
 * whatever X402_FACILITATOR_URL says. Unset: X402_FACILITATOR_URL, else the
 * network default — so this deploys unchanged until the keys are added.
 */
function getFacilitator(): FacilitatorConfig {
  const keyId = process.env.CDP_API_KEY_ID
  const keySecret = process.env.CDP_API_KEY_SECRET
  if (keyId && keySecret) return createFacilitatorConfig(keyId, keySecret)

  const url = (process.env.X402_FACILITATOR_URL ||
    (NETWORK === 'base' ? CDP_FACILITATOR_URL : X402_ORG_FACILITATOR_URL)) as `${string}://${string}`
  if (url.startsWith('https://api.cdp.coinbase.com') && !warnedUnauthenticatedCdp) {
    warnedUnauthenticatedCdp = true
    console.error('[x402] CDP facilitator without CDP_API_KEY_ID / CDP_API_KEY_SECRET: every verify and settle will 401')
  }
  return { url }
}

/**
 * A paid resource as the x402 Bazaar lists it. The description is also the
 * 402 body's `description`; inputSchema/outputSchema are discovery metadata
 * only and play no part in verifying or settling a payment.
 */
export type PaidResource = {
  description: string
  inputSchema?: Omit<HTTPRequestStructure, 'type' | 'method'>
  outputSchema: Record<string, unknown>
}

async function buildPaymentRequirements(
  price: Price,
  resourceUrl: string,
  method: HTTPRequestStructure['method'],
  { description, inputSchema, outputSchema }: PaidResource
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
      outputSchema: {
        input: { type: 'http', method, discoverable: true, ...inputSchema },
        output: outputSchema,
      },
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

/** A payment that passed facilitator verification but has not been settled. */
export type VerifiedPayment = {
  payload: PaymentPayload
  requirements: PaymentRequirements
  allRequirements: PaymentRequirements[]
}

/**
 * Phase 1 of two-phase x402. Decodes and verifies the X-PAYMENT header
 * WITHOUT settling it, so the handler can run its own preflight and reject a
 * request before the payer is charged. Returns the 402 response on failure.
 */
export async function verifyPayment(
  request: NextRequest,
  price: Price,
  resource: PaidResource
): Promise<{ ok: true; payment: VerifiedPayment } | { ok: false; response: NextResponse }> {
  const { verify } = useFacilitator(getFacilitator())
  const resourceUrl = request.nextUrl.toString()
  const method = request.method.toUpperCase() as HTTPRequestStructure['method']
  const paymentRequirements = await buildPaymentRequirements(price, resourceUrl, method, resource)
  const fail = (error: string) => ({ ok: false as const, response: paymentRequired(paymentRequirements, error) })

  const paymentHeader = request.headers.get('X-PAYMENT')
  if (!paymentHeader) return fail('X-PAYMENT header is required')

  let decodedPayment: PaymentPayload
  try {
    decodedPayment = exact.evm.decodePayment(paymentHeader)
    decodedPayment.x402Version = X402_VERSION
  } catch (err) {
    return fail(err instanceof Error ? err.message : 'Invalid payment')
  }

  const selectedRequirements = findMatchingPaymentRequirements(paymentRequirements, decodedPayment)
  if (!selectedRequirements) return fail('Unable to find matching payment requirements')

  const verification = await verify(decodedPayment, selectedRequirements)
  if (!verification.isValid) return fail(verification.invalidReason ?? 'Payment verification failed')

  return {
    ok: true,
    payment: { payload: decodedPayment, requirements: selectedRequirements, allRequirements: paymentRequirements },
  }
}

/**
 * Phase 2 of two-phase x402. Settles a payment returned by verifyPayment().
 * On success returns the facilitator's settlement (tx hash, payer); on
 * failure a 402 response. A facilitator error counts as a failed settlement.
 */
export async function settlePayment(
  payment: VerifiedPayment
): Promise<{ ok: true; settlement: SettleResponse } | { ok: false; response: NextResponse }> {
  const { settle } = useFacilitator(getFacilitator())
  let settlement: SettleResponse
  try {
    settlement = await settle(payment.payload, payment.requirements)
  } catch (err) {
    console.error('[x402] settle failed', err)
    return { ok: false, response: paymentRequired(payment.allRequirements, 'Failed to settle payment') }
  }
  if (!settlement.success) {
    return { ok: false, response: paymentRequired(payment.allRequirements, settlement.errorReason ?? 'Failed to settle payment') }
  }
  return { ok: true, settlement }
}

/**
 * Runs an x402-priced route: verify the payment, run `handler`, and settle
 * only if the handler answered 2xx. A 4xx/5xx (bad params, unknown gameId,
 * market not open) or a thrown error is returned as-is and costs the payer
 * nothing — the verified authorization is simply never submitted.
 *
 * The data is released only once the payment has settled: if settlement
 * fails, the caller gets a 402 instead of the handler's body. On success the
 * response carries the standard X-PAYMENT-RESPONSE header (settlement tx).
 */
export async function withPayment(
  request: NextRequest,
  price: Price,
  resource: PaidResource,
  handler: () => Promise<NextResponse>
): Promise<NextResponse> {
  const verified = await verifyPayment(request, price, resource)
  if (!verified.ok) return verified.response

  const response = await handler()
  if (response.status < 200 || response.status >= 300) return response

  const settled = await settlePayment(verified.payment)
  if (!settled.ok) return settled.response
  response.headers.set('X-PAYMENT-RESPONSE', settleResponseHeader(settled.settlement))
  return response
}
