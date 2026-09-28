'use client'

import { useEffect } from 'react'
import { usePathname } from 'next/navigation'
import { captureRefFromUrl } from '@/lib/share-ref'

export function RefCapture() {
  const pathname = usePathname()
  useEffect(() => {
    captureRefFromUrl()
  }, [pathname])
  return null
}
