import { getAddress, isAddress, type Address } from 'viem'
import builders from '@/data/builders.json'
import { normalizeRef } from '@/lib/attribution'

// Server-side. data/builders.json is the human gate for builder payouts: only rows with
// approved: true earn the fee share. Any other valid address earns referral points only.

interface BuilderRow {
  code: string
  payoutAddress: string
  approved: boolean
  label?: string
}

export type ResolvedRef =
  | { type: 'builder'; id: string; payoutAddress: Address }
  | { type: 'address'; id: Address }

const approvedBuilders = new Map(
  (builders as BuilderRow[])
    .filter((b) => b.approved === true && isAddress(b.payoutAddress))
    .map((b) => [b.code.toLowerCase(), getAddress(b.payoutAddress)] as const),
)

export function resolveRef(raw: unknown): ResolvedRef | null {
  const ref = normalizeRef(raw)
  if (ref === null) return null
  if (ref.startsWith('0x')) return { type: 'address', id: getAddress(ref) }
  const payoutAddress = approvedBuilders.get(ref)
  return payoutAddress ? { type: 'builder', id: ref, payoutAddress } : null
}

/** resolveRef, minus self-referral: a ref that pays the bettor is no ref. */
export function resolveRefForBettor(raw: unknown, bettor: Address): ResolvedRef | null {
  const ref = resolveRef(raw)
  if (ref === null) return null
  const beneficiary = ref.type === 'builder' ? ref.payoutAddress : ref.id
  return beneficiary.toLowerCase() === bettor.toLowerCase() ? null : ref
}
