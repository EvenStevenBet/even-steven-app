import { NextResponse } from 'next/server'
import Papa from 'papaparse'
import type { MarketRow } from '@/lib/markets'
import fallbackData from '@/data/markets.json'

// Revalidate every 60 seconds — sheet updates are reflected within a minute
export const revalidate = 60

export async function GET() {
  const csvUrl = process.env.NEXT_PUBLIC_SHEET_CSV_URL

  if (!csvUrl) {
    return NextResponse.json(fallbackData)
  }

  try {
    const res = await fetch(csvUrl, {
      next: { revalidate: 60 },
      headers: { Accept: 'text/csv' },
    })

    if (!res.ok) throw new Error(`Sheet fetch failed: ${res.status}`)

    const text = await res.text()
    const { data, errors } = Papa.parse<MarketRow>(text, {
      header: true,
      skipEmptyLines: true,
      transformHeader: h => h.trim(),
      transform: v => v.trim(),
    })

    if (errors.length > 0) {
      console.error('[markets] CSV parse errors:', errors.slice(0, 3))
    }

    // Filter out rows with no gameId (blank rows at bottom of sheet)
    const clean = data.filter(r => Boolean(r.gameId))
    return NextResponse.json(clean)
  } catch (err) {
    console.error('[markets] Falling back to static data:', err)
    return NextResponse.json(fallbackData)
  }
}
