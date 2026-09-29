'use client'

import { useEffect, useState } from 'react'
import { formatLocalDate, formatMarketDate } from '@/lib/format'

interface Props {
  value: string | undefined | null
  options: Intl.DateTimeFormatOptions
  withTime?: boolean
  prefix?: string
  className?: string
}

// The server can't know the viewer's timezone, so the first render (server and hydration)
// uses the UTC date and the viewer's local date and time replace it after mount.
export function LocalDate({ value, options, withTime = false, prefix = '', className }: Props) {
  const [local, setLocal] = useState<string | null>(null)
  useEffect(() => {
    setLocal(formatLocalDate(value, options, withTime))
    // options is an inline literal at every call site; value is what can actually change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, withTime])
  const text = local ?? formatMarketDate(value, options)
  if (!text) return null
  return (
    <time dateTime={value ?? undefined} className={className}>
      {prefix}
      {text}
    </time>
  )
}
