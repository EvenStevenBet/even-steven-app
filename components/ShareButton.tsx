'use client'

import { useState } from 'react'
import { APP_URL } from '@/lib/chain'
import { usePlatformLaunch } from '@/hooks/usePlatformLaunch'

interface Props {
  text: string
  /** Path relative to APP_URL, e.g. /bet/0x…/3 — omit to share the app root. */
  path?: string
}

// In-app browsers (X, Farcaster) often block the async Clipboard API.
function legacyCopy(value: string): boolean {
  const el = document.createElement('textarea')
  el.value = value
  el.setAttribute('readonly', '')
  el.style.position = 'fixed'
  el.style.opacity = '0'
  document.body.appendChild(el)
  el.select()
  try {
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    document.body.removeChild(el)
  }
}

export function ShareButton({ text, path }: Props) {
  const [copied, setCopied] = useState(false)
  const platform = usePlatformLaunch()
  const url = `${APP_URL}${path ?? ''}`

  function shareX() {
    const intent = `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`
    window.open(intent, '_blank', 'noopener,noreferrer')
  }

  // Inside Farcaster / Base App the SDK opens the native composer with the link as an
  // embed, which unfurls as a tappable Mini App card. In a browser the web composer opens
  // synchronously, inside the tap, so popup blockers allow it.
  function openWebComposer() {
    const compose = `https://warpcast.com/~/compose?text=${encodeURIComponent(text)}&embeds[]=${encodeURIComponent(url)}`
    window.open(compose, '_blank', 'noopener,noreferrer')
  }

  async function shareFarcaster() {
    if (platform !== 'farcaster' && platform !== 'baseApp') return openWebComposer()
    try {
      // Loaded on tap so the SDK stays out of the market page's first-load bundle.
      const { sdk } = await import('@farcaster/miniapp-sdk')
      await sdk.actions.composeCast({ text, embeds: [url] })
    } catch {
      openWebComposer()
    }
  }

  async function copyLink() {
    let ok = false
    try {
      await navigator.clipboard.writeText(url)
      ok = true
    } catch {
      ok = legacyCopy(url)
    }
    if (ok) {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" onClick={shareX} className="btn-ghost text-xs px-3 py-1.5">
        Share on X
      </button>
      <button type="button" onClick={shareFarcaster} className="btn-ghost text-xs px-3 py-1.5">
        Farcaster
      </button>
      <button type="button" onClick={copyLink} className="btn-ghost text-xs px-3 py-1.5">
        {copied ? 'Copied' : 'Copy link'}
      </button>
    </div>
  )
}
