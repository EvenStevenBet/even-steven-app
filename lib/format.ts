// Shared display formatting.

// Z / spread values are 4-decimal fixed point (-35000 => -3.5).
export function formatZDisplay(z: bigint): string {
  const n = Number(z) / 10000
  return Number.isInteger(n) ? n.toString() : n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')
}

// USDC is 6 decimals on Base. Always two decimals so columns line up.
export function formatUsdc(raw: bigint | undefined | null, fallback = '—'): string {
  if (raw === undefined || raw === null) return fallback
  return (Number(raw) / 1e6).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

// Whole amounts lose the ".00" at glance size; cents stay wherever they exist.
function compactUsdc(raw: bigint): string {
  const formatted = formatUsdc(raw)
  return formatted.endsWith('.00') ? formatted.slice(0, -3) : formatted
}

/**
 * "$100 → $196.19" — the payout is always quoted against the STAKE, never
 * against the fee-inclusive total. The fee is paid up front and itemised on its
 * own line; dividing the payout by stake + fee would count it twice and turn a
 * 2.00x product into a 1.96x one on screen.
 */
export function formatStakeToPayout(stake: bigint, payout: bigint | undefined): {
  stake: string
  payout: string
} {
  return {
    stake: `$${compactUsdc(stake)}`,
    payout: payout === undefined ? '→ …' : `→ $${compactUsdc(payout)}`,
  }
}

// CSV dates arrive either as a bare day ("2026-09-06", the static fallback) or
// as a full instant ("2026-09-11T00:35:00Z", what the bot writes). Normalise
// both rather than concatenating a time onto something that already has one.
export function parseMarketDate(value: string | undefined | null): Date | null {
  if (!value) return null
  const raw = value.trim()
  if (raw === '') return null
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T12:00:00Z` : raw)
  return Number.isNaN(d.getTime()) ? null : d
}

export function formatMarketDate(
  value: string | undefined | null,
  options: Intl.DateTimeFormatOptions,
): string | null {
  const d = parseMarketDate(value)
  return d === null ? null : d.toLocaleDateString('en-US', { timeZone: 'UTC', ...options })
}
