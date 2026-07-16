import type { Config } from 'tailwindcss'

const config: Config = {
  content: [
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './hooks/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        gold: '#f5c842',
        win:  '#00e676',
        bg:   '#0a0a0a',
      },
      fontFamily: {
        display: ['var(--font-display)', 'Oswald', 'sans-serif'],
        body:    ['var(--font-body)', 'Inter', 'sans-serif'],
      },
      // Ticket-stub edge for market cards
      backgroundImage: {
        'ticket-edge': `repeating-linear-gradient(
          90deg,
          transparent,
          transparent 8px,
          #1a1a1a 8px,
          #1a1a1a 10px
        )`,
      },
      screens: {
        xs: '380px',
      },
    },
  },
  plugins: [],
}

export default config
