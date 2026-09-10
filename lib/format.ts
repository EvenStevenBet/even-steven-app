// Shared display formatting for the agent-facing API routes.

// Z / spread values are 4-decimal fixed point (-35000 => -3.5).
export function formatZDisplay(z: bigint): string {
  const n = Number(z) / 10000
  return Number.isInteger(n) ? n.toString() : n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')
}
