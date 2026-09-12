// One definition of the label so the slip and the market card can never drift.
export const FIRST_MOVER_LABEL = '🔥 First mover · early edge available'

export function FirstMoverBadge({ className }: { className?: string }) {
  return (
    <span
      className={[
        'inline-flex items-center rounded-full border border-gold/30 bg-gold/10',
        'px-2.5 py-1 text-[11px] font-display font-semibold tracking-wide text-gold',
        className ?? '',
      ].join(' ')}
    >
      {FIRST_MOVER_LABEL}
    </span>
  )
}
