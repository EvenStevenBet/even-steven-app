import { normalizeRef } from '@/lib/attribution'

// The ref from a share link (?ref=). The bet reads it back from, in order: session storage, the
// address bar, then an in-memory copy. Storage can be missing or throw (private windows, in-app
// browsers) and the address bar loses the query on in-page navigation, so each covers the other.
// If none has a code the bet is placed with no code, exactly as before. Validation is unchanged
// (normalizeRef); whether a code earns anything is decided server-side by the approved-builder check.
const KEY = 'es:ref'

// Survives in-page navigation when storage is blocked. Lost on a full page load, which is when
// the address bar carries the ref again.
let memoryRef: string | null = null

function refFromAddressBar(): string | null {
  if (typeof window === 'undefined') return null
  try {
    return normalizeRef(new URLSearchParams(window.location.search).get('ref'))
  } catch {
    return null
  }
}

export function captureRefFromUrl(): void {
  const ref = refFromAddressBar()
  if (ref === null) return
  memoryRef = ref
  try {
    sessionStorage.setItem(KEY, ref)
  } catch {}
}

export function getStoredRef(): string | null {
  let stored: string | null = null
  try {
    stored = normalizeRef(sessionStorage.getItem(KEY))
  } catch {}
  if (stored !== null) return stored
  const fromUrl = refFromAddressBar()
  if (fromUrl !== null) {
    memoryRef = fromUrl
    return fromUrl
  }
  return memoryRef
}

/** Test hook: forget the in-memory copy, as a full page load does. */
export function resetRefMemory(): void {
  memoryRef = null
}
