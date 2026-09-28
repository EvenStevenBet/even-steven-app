// Server-side. data/points.json is generated hourly in the even-steven repo by scripts/points.mjs.

const POINTS_URL =
  process.env.POINTS_JSON_URL ?? 'https://raw.githubusercontent.com/EvenStevenBet/even-steven/main/data/points.json'

export interface PointsRow {
  address: string
  total: number
  betPoints: number
  referralPoints: number
}

export interface PointsFile {
  updatedAt: string
  pointsPerUsdc: number
  refPointsPerUsdc: number
  addresses: PointsRow[]
}

export async function fetchPoints(): Promise<PointsFile | null> {
  try {
    const res = await fetch(POINTS_URL, { next: { revalidate: 300 } })
    if (!res.ok) return null
    return (await res.json()) as PointsFile
  } catch {
    return null
  }
}
