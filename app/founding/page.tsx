import type { Metadata } from 'next'
import {
  FOUNDING_SEATS_CLAIMED,
  FOUNDING_SEATS_TOTAL,
  FOUNDING_USDC_PLEDGED,
  FOUNDING_GOAL_WALLETS,
  FOUNDING_FORM_URL,
} from '@/lib/founding'

export const metadata: Metadata = {
  title: 'Founding seats',
  description:
    'Back either side at even money. The spread moves to balance the pool, so $100 wins $100.',
}

export default function FoundingPage() {
  return (
    <main className="max-w-2xl mx-auto px-4 py-16 space-y-12">
      <header className="space-y-4">
        <div
          className="font-display text-6xl font-bold text-gold leading-none select-none"
          aria-hidden
        >
          =
        </div>
        <h1 className="font-display text-4xl sm:text-5xl font-bold leading-tight">
          Founding seats.
        </h1>
        <p className="text-white/70 text-lg leading-relaxed">
          Back either side at even money. The spread moves to balance the pool, so $100 wins $100.
        </p>
      </header>

      <section aria-labelledby="founding-figures" className="space-y-4">
        <h2 id="founding-figures" className="sr-only">
          Founding seats so far
        </h2>
        <dl className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-lg border border-white/10 p-5">
            <dt className="text-xs uppercase tracking-widest text-white/40">
              Seats claimed (pledged, not bet)
            </dt>
            <dd className="mt-2 font-display text-4xl font-bold text-gold tabular">
              {FOUNDING_SEATS_CLAIMED} of {FOUNDING_SEATS_TOTAL}
            </dd>
          </div>
          <div className="rounded-lg border border-white/10 p-5">
            <dt className="text-xs uppercase tracking-widest text-white/40">
              Total pledged (pledged, not bet)
            </dt>
            <dd className="mt-2 font-display text-4xl font-bold text-gold tabular">
              {FOUNDING_USDC_PLEDGED} USDC
            </dd>
          </div>
        </dl>
        <p className="text-xs text-white/40">Figures are updated by hand.</p>
      </section>

      <section className="space-y-4">
        <p className="text-white/70 leading-relaxed">
          A pledge is not a bet. It moves no money, and the market opens only when{' '}
          {FOUNDING_GOAL_WALLETS} wallets have pledged. Founding bettors pledge between 25 and 100 USDC and pick no side now.
        </p>
        {FOUNDING_FORM_URL && (
          <a
            href={FOUNDING_FORM_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="btn-gold inline-flex"
          >
            Pledge a seat
          </a>
        )}
      </section>
    </main>
  )
}
