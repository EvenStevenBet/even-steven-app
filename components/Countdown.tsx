'use client'

import { useEffect, useState } from 'react'

interface Props {
  /** Kickoff, from the market CSV's gameDate column. Never parsed out of gameId. */
  closesAt: string
  className?: string
}

function remaining(msLeft: number): string {
  const total = Math.floor(msLeft / 1000)
  const days = Math.floor(total / 86400)
  const hours = Math.floor((total % 86400) / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60

  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

export function Countdown({ closesAt, className }: Props) {
  // null until the first client tick — rendering a live clock during SSR would
  // hydrate against a different second.
  const [label, setLabel] = useState<string | null>(null)

  useEffect(() => {
    const target = new Date(closesAt).getTime()
    if (Number.isNaN(target)) {
      setLabel(null)
      return
    }

    function tick() {
      const msLeft = target - Date.now()
      setLabel(msLeft <= 0 ? 'Betting has closed' : `Betting closes in ${remaining(msLeft)}`)
    }

    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [closesAt])

  if (label === null) return null

  return (
    <p className={className ?? 'text-xs text-white/50 tabular'} suppressHydrationWarning>
      {label}
    </p>
  )
}
