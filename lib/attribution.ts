import { isAddress, type Hex } from 'viem'

// ERC-8021 schema 0 suffix: codes ∥ codesLength (1 byte) ∥ schemaId 0x00 ∥ 16-byte marker,
// codes comma-delimited ASCII. Solidity ignores trailing calldata, so appending it changes
// nothing on-chain. Byte layout matches ox/erc8021 Attribution.toDataSuffix (ox 1.8.5).
const MARKER = '80218021802180218021802180218021'

/**
 * Even Steven's own Base builder code (dashboard.base.org → Project Settings). It goes on
 * every Even Steven transaction for Base's attribution and rewards, first in the code list,
 * and is never a referrer: refsFromCalldata drops it, so it earns no points or fee share.
 */
export const ES_BUILDER_CODE = 'bc_ncytgilx'

const BUILDER_CODE = /^[a-z0-9-]{3,32}$/

/** A syntactically valid ref (builder code or address), lowercased. Says nothing about approval. */
export function normalizeRef(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const ref = raw.trim().toLowerCase()
  if (BUILDER_CODE.test(ref)) return ref
  if (isAddress(ref, { strict: false })) return ref
  return null
}

/** The suffix for every Even Steven transaction: our builder code, then the third-party ref if any. */
export function attributionSuffix(ref?: string | null): Hex {
  const list = ref && ref !== ES_BUILDER_CODE ? [ES_BUILDER_CODE, ref] : [ES_BUILDER_CODE]
  const codes = Array.from(new TextEncoder().encode(list.join(',')), (b) => b.toString(16).padStart(2, '0')).join('')
  const length = (codes.length / 2).toString(16).padStart(2, '0')
  return `0x${codes}${length}00${MARKER}`
}

/**
 * Every third-party schema-0 code found anywhere in the calldata (our own builder code excluded). Scans rather than reading only the
 * tail: in a Smart Wallet transaction the placeBet calldata (and its suffix) sits inside
 * EntryPoint.handleOps, followed by ABI padding.
 */
export function refsFromCalldata(input: Hex): string[] {
  const hex = input.slice(2).toLowerCase()
  const found: string[] = []
  for (let at = hex.indexOf(MARKER); at !== -1; at = hex.indexOf(MARKER, at + 2)) {
    if (at % 2 !== 0 || at < 4 || hex.slice(at - 2, at) !== '00') continue
    const length = parseInt(hex.slice(at - 4, at - 2), 16)
    const start = at - 4 - length * 2
    if (length === 0 || start < 0) continue
    const bytes = hex.slice(start, at - 4).match(/../g)!.map((b) => parseInt(b, 16))
    if (!bytes.every((b) => b >= 0x20 && b < 0x7f)) continue
    found.push(...String.fromCharCode(...bytes).split(','))
  }
  return found.filter((code) => code.toLowerCase() !== ES_BUILDER_CODE)
}
