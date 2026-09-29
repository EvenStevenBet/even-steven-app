import type { Metadata } from 'next'
import { WalletCheck } from './WalletCheck'

export const metadata: Metadata = {
  title: 'Wallet check',
  robots: { index: false, follow: false },
}

export default function WalletCheckPage() {
  return <WalletCheck />
}
