import { FACTORY_ADDRESS, BASESCAN_URL } from '@/lib/chain'

const GITHUB_URL = 'https://github.com/EvenStevenBet/even-steven'

const TRUST_ITEMS = [
  {
    label: 'Verified on BaseScan',
    href: () => `${BASESCAN_URL}/address/${FACTORY_ADDRESS}`,
    external: true,
  },
  {
    label: 'Open source (MIT)',
    href: () => GITHUB_URL,
    external: true,
  },
  {
    label: 'Settled by UMA oracle',
    href: () => '/how-it-works#settlement',
    external: false,
  },
  {
    label: 'No owner override',
    href: () => '/how-it-works#trustless',
    external: false,
  },
]

export function TrustStrip() {
  return (
    <div className="border-t border-white/8 py-4 px-4">
      <div className="max-w-5xl mx-auto">
        <ul className="flex flex-wrap justify-center gap-x-6 gap-y-2 text-xs text-white/40">
          {TRUST_ITEMS.map(({ label, href, external }) => (
            <li key={label}>
              <a
                href={href()}
                {...(external
                  ? { target: '_blank', rel: 'noopener noreferrer' }
                  : {})}
                className="hover:text-white/70 transition-colors underline-offset-2 hover:underline"
              >
                {label}
              </a>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
