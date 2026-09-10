import { paymentMiddleware } from 'x402-next'

// x402-protected agent API routes. Human-facing routes (/api/markets, the
// frontend) are untouched — see the matcher below.
export const middleware = paymentMiddleware(
  process.env.X402_RECEIVING_ADDRESS as `0x${string}`,
  {
    '/api/markets/agent': { price: '$0.05', network: 'base' },
    '/api/bet/quote': { price: '$0.01', network: 'base' },
    '/api/bet/status': { price: '$0.01', network: 'base' },
  },
  {
    url: (process.env.X402_FACILITATOR_URL ?? 'https://x402.org/facilitator') as `${string}://${string}`,
  }
)

export const config = {
  matcher: ['/api/markets/agent', '/api/bet/quote', '/api/bet/status'],
}
