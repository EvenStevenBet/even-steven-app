import type { Metadata } from 'next'
import { fetchPoints } from '@/lib/points'

export const revalidate = 300

export const metadata: Metadata = {
  title: 'Points',
  description: 'Points for every bet placed, win or lose, and for the bets your link brings in.',
}

function short(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}

export default async function PointsPage() {
  const file = await fetchPoints()
  const top = file?.addresses.slice(0, 50) ?? []

  return (
    <main className="max-w-2xl mx-auto px-4 py-12 space-y-6">
      <header className="space-y-2">
        <h1 className="font-display text-4xl font-bold">Points</h1>
        {file && (
          <p className="text-sm text-white/60 leading-relaxed">
            {file.pointsPerUsdc} points per USDC you stake, win or lose. {file.refPointsPerUsdc} per USDC staked by
            bets your share link brings in — tail or fade. A ledger, not a token: points can&apos;t be transferred or
            redeemed.
          </p>
        )}
      </header>

      {!file ? (
        <p className="text-sm text-white/50">The points ledger is unavailable right now.</p>
      ) : top.length === 0 ? (
        <p className="text-sm text-white/50">No points yet. Place the first bet.</p>
      ) : (
        <div className="ticket overflow-x-auto">
          <table className="w-full text-sm tabular">
            <thead>
              <tr className="text-[10px] text-white/40 uppercase tracking-widest font-display text-left">
                <th className="px-4 py-3 font-normal">#</th>
                <th className="px-4 py-3 font-normal">Wallet</th>
                <th className="px-4 py-3 font-normal text-right">Bets</th>
                <th className="px-4 py-3 font-normal text-right">Referrals</th>
                <th className="px-4 py-3 font-normal text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              {top.map((row, i) => (
                <tr key={row.address} className="border-t border-white/5">
                  <td className="px-4 py-2.5 text-white/40">{i + 1}</td>
                  <td className="px-4 py-2.5 font-mono text-xs text-white/80" title={row.address}>{short(row.address)}</td>
                  <td className="px-4 py-2.5 text-right text-white/60">{row.betPoints.toLocaleString('en-US')}</td>
                  <td className="px-4 py-2.5 text-right text-white/60">{row.referralPoints.toLocaleString('en-US')}</td>
                  <td className="px-4 py-2.5 text-right font-semibold text-gold">{row.total.toLocaleString('en-US')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {file && (
        <p className="text-[11px] text-white/35">
          Updated hourly. Last update {new Date(file.updatedAt).toUTCString()}.
        </p>
      )}
    </main>
  )
}
