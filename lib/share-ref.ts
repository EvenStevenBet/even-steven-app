import { normalizeRef } from '@/lib/attribution'

// The ref from a share link (?ref=), held for the tab session. Only a convenience:
// storage can be missing or throw (private windows, in-app browsers), and then the
// bet simply goes unattributed.
const KEY = 'es:ref'

export function captureRefFromUrl(): void {
  const ref = normalizeRef(new URLSearchParams(window.location.search).get('ref'))
  if (ref === null) return
  try {
    sessionStorage.setItem(KEY, ref)
  } catch {}
}

export function getStoredRef(): string | null {
  try {
    return normalizeRef(sessionStorage.getItem(KEY))
  } catch {
    return null
  }
}
