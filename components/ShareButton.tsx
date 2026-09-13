'use client'

import { useState } from 'react'
import { APP_URL } from '@/lib/chain'

interface Props {
  text: string
  /** Path relative to APP_URL, e.g. /market/NFL-2026-... — omit to share the app root. */
  path?: string
}

// Share-a-bet (BUILD-SPEC.md §7): X share intent + copy-link, the browser-context
// half of the spec. The Farcaster/Base App half (Mini App SDK compose-cast) is not
// wired up here — @farcaster/frame-sdk (the version already in this app's dependency
// tree via onchainkit/minikit) predates composeCast, and the version that has it
// (@farcaster/miniapp-sdk) isn't a declared dependency of this app. Flagging rather
// than reaching for an undeclared transitive package.
export function ShareButton({ text, path }: Props) {
  const [copied, setCopied] = useState(false)
  const url = `${APP_URL}${path ?? ''}`

  function shareX() {
    const intent = `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`
    window.open(intent, '_blank', 'noopener,noreferrer')
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard API unavailable — nothing to fall back to silently; leave state as-is.
    }
  }

  return (
    <div className="flex items-center gap-2">
      <button type="button" onClick={shareX} className="btn-ghost text-xs px-3 py-1.5">
        Share on X
      </button>
      <button type="button" onClick={copyLink} className="btn-ghost text-xs px-3 py-1.5">
        {copied ? 'Copied!' : 'Copy link'}
      </button>
    </div>
  )
}
