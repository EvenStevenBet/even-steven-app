import type { Metadata } from 'next'
import Link from 'next/link'

export const metadata: Metadata = {
  title: 'How It Works',
  description:
    'Even Steven is a parimutuel sportsbook with no house edge. Winners split 100% of the pool. 2% fee, charged once at bet placement.',
}

const GITHUB_URL  = 'https://github.com/EvenStevenBet/even-steven'
const AGENTS_URL  = 'https://github.com/EvenStevenBet/even-steven/blob/main/AGENTS.md'
const BASESCAN    = 'https://basescan.org'
const SEPOLIA_BS  = 'https://sepolia.basescan.org'

// Mainnet deployment facts — hardcoded, not env-driven
const MAIN = {
  factoryV13: '0x9E9C769aaCa509cD67Fbca2236dB26d8428a8027',
  factoryV12: '0x08BA5624107536d1CEA043B372978E7e9516E214', // retired
  usdc:       '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  umaOov3:    '0x2aBf1Bd76655de80eDB3086114315Eec75AF500c',
  deployTx:   '0x2ec96b82ced224a4eefa68b7b75ae30f20bb1ec810c069d94efbeb00408f0d25',
} as const

const TESTNET = {
  market:  '0xF536a69C12230FB094fA3C5850f8569957158AC2',
  usdc:    '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
  umaOov3: '0x0F7fC5E6482f096380db6158f978167b57388deE',
} as const

// Friction table — source: README.md "What you actually pay"
// All numbers from April 2026 screenshots + published fee schedules
const FRICTION = [
  { platform: 'Even Steven',     depth: 'Any market, any size',   taker: '2.00%', over: '0%',      slip: '0%',      settle: '0%',   total: '2.00%', hl: true  },
  { platform: 'Polymarket US',   depth: 'Liquid (NFL/NBA main)',  taker: '2.50%', over: '~2%',     slip: '~0.4%',   settle: '0%',   total: '~4.9%', hl: false },
  { platform: 'Polymarket Global', depth: 'Liquid ($1M+ vol)',    taker: '0.75%', over: '~2%',     slip: '~0.4%',   settle: '0%',   total: '~4.7%', hl: false },
  { platform: 'Kalshi',          depth: 'Liquid (NBA playoffs)',  taker: '3.50%', over: '~2%',     slip: '~0.5%',   settle: '2.00%', total: '~8.0%', hl: false },
  { platform: 'Polymarket US',   depth: 'Medium (NBA prop)',      taker: '2.50%', over: '~4%',     slip: '~0.8%',   settle: '0%',   total: '~7–8%', hl: false },
  { platform: 'Kalshi',          depth: 'Medium liquidity',       taker: '3.50%', over: '~3–4%',   slip: '~1%',     settle: '2.00%', total: '~12–15%', hl: false },
  { platform: 'Polymarket',      depth: 'Illiquid ($0 vol)',      taker: '0.75–2.50%', over: '~9%+', slip: '~3.5%+', settle: '0%',  total: '~17–20%+', hl: false },
] as const

export default function HowItWorksPage() {
  return (
    <main className="max-w-2xl mx-auto px-4 py-16 space-y-16">

      <header className="space-y-3">
        <div
          className="font-display text-6xl font-bold text-gold leading-none select-none"
          aria-hidden
        >
          =
        </div>
        <h1 className="font-display text-4xl sm:text-5xl font-bold leading-tight">
          How it works.
        </h1>
        <p className="text-white/60 text-lg leading-relaxed">
          Written for skeptics. No hand-waving.
        </p>
      </header>

      {/* ── 01. Even betting ─────────────────────────────────────────────── */}
      <Section id="even-betting" number="01" title="Even betting">
        <p>
          Traditional sportsbooks build an overround into every line — they
          price both sides to pay out less than 100 cents on the dollar. The
          margin is silent and structural.
        </p>
        <p className="mt-4">
          Even Steven is <strong className="text-white">parimutuel</strong>: every dollar staked
          on the losing side goes to the winning side. No house pool. No
          overround. Winners split 100% of losers&apos; stakes.
        </p>
        <p className="mt-4">
          At a liquid market — equal money on both sides — a $100 stake returns
          $200 gross on a win. 1:1 payout. The house was the hidden cost.{' '}
          <span className="text-gold">We removed it.</span>
        </p>
      </Section>

      {/* ── 02. The fee, honestly ────────────────────────────────────────── */}
      <Section id="fee" number="02" title="The fee, honestly.">
        <p>
          There is one fee: <strong className="text-white">2% of your stake, charged
          once at bet placement.</strong> It never touches the pool.
        </p>

        <div className="mt-6 rounded-lg border border-white/10 bg-white/4 p-5 space-y-2 tabular text-sm">
          <Row label="Stake" value="$100.00" />
          <Row label="Fee (2%)" value="$2.00" className="text-white/60" />
          <div className="border-t border-white/10 pt-2">
            <Row label="Total cost" value="$102.00" bold />
          </div>
          <Row label="Gross payout at liquidity" value="~$200.00" className="text-gold" />
          <div className="border-t border-white/10 pt-2">
            <Row label="Net profit" value="~$98.00" bold className="text-win" />
          </div>
        </div>

        <p className="mt-5 text-white/60 text-sm">
          The 2% is set in the contract as{' '}
          <code className="text-gold/90">FEE_PERCENT = 200</code> (200 basis
          points). It is immutable per deployed market — it cannot be changed
          after the contract is live. There is no settlement fee. No claim fee.
          No surprises.
        </p>
      </Section>

      {/* ── 02b. What you actually pay ──────────────────────────────────── */}
      {/* Full-width section — table breaks out of pl-11 intentionally */}
      <section id="friction-table" className="scroll-mt-20 space-y-6">
        <header className="flex items-baseline gap-3">
          <span
            className="font-display text-xs font-semibold text-gold/50 tracking-widest uppercase tabular w-8 shrink-0"
            aria-hidden
          >
            02b
          </span>
          <h2 className="font-display text-2xl sm:text-3xl font-bold leading-tight">
            What you actually pay.
          </h2>
        </header>

        <div className="pl-11 text-white/70 text-sm leading-relaxed space-y-3">
          <p>
            Every prediction market advertises a low fee. None of them tell you
            the full cost — because the full cost is the house, and the house is
            the business.
          </p>
          <p>
            On an order book you pay three things every trade: the{' '}
            <strong className="text-white">taker fee</strong> (the number they
            advertise), the{' '}
            <strong className="text-white">overround</strong> (both sides sum
            past 100¢ and you pay the gap), and{' '}
            <strong className="text-white">slippage</strong> (your order eats
            the book at progressively worse prices). Rename those three and you
            have a bookie — the vig, the spread, the line move. They are
            invisible, variable, and depth-dependent, and they are exactly the
            margins the house has always taken. Moving them on-chain did not
            remove them; it hid them in the microstructure.
          </p>
          <p>
            Even Steven has none of them. No order book means no overround and
            no slippage. You pay one thing: a flat 2% protocol fee on your
            stake, charged the moment you place the bet.
          </p>
        </div>

        {/* Friction table — horizontal scroll on mobile */}
        <div className="overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0">
          <p className="sm:hidden text-[10px] text-white/30 text-right mb-1 pr-1">
            scroll →
          </p>
          <table className="min-w-[680px] w-full text-xs border-collapse">
            <thead>
              <tr className="border-b border-white/10">
                <th className="text-left py-2 pr-4 font-display font-semibold text-white/50 uppercase tracking-widest">Platform</th>
                <th className="text-left py-2 pr-4 font-display font-semibold text-white/50 uppercase tracking-widest">Market Depth</th>
                <th className="text-right py-2 pr-4 font-display font-semibold text-white/50 uppercase tracking-widest tabular">Taker Fee</th>
                <th className="text-right py-2 pr-4 font-display font-semibold text-white/50 uppercase tracking-widest tabular">Overround</th>
                <th className="text-right py-2 pr-4 font-display font-semibold text-white/50 uppercase tracking-widest tabular">Slippage</th>
                <th className="text-right py-2 pr-4 font-display font-semibold text-white/50 uppercase tracking-widest tabular">Settlement</th>
                <th className="text-right py-2 font-display font-bold text-white/70 uppercase tracking-widest tabular">Total</th>
              </tr>
            </thead>
            <tbody>
              {FRICTION.map((row, i) => (
                <tr
                  key={i}
                  className={[
                    'border-b border-white/5',
                    row.hl
                      ? 'bg-gold/5 border-l-2 border-l-gold/60'
                      : 'hover:bg-white/3',
                  ].join(' ')}
                >
                  <td className={`py-2.5 pr-4 font-semibold ${row.hl ? 'text-gold' : 'text-white/80'}`}>
                    {row.platform}
                  </td>
                  <td className="py-2.5 pr-4 text-white/50">{row.depth}</td>
                  <td className="py-2.5 pr-4 text-right tabular text-white/70">{row.taker}</td>
                  <td className="py-2.5 pr-4 text-right tabular text-white/70">{row.over}</td>
                  <td className="py-2.5 pr-4 text-right tabular text-white/70">{row.slip}</td>
                  <td className="py-2.5 pr-4 text-right tabular text-white/70">{row.settle}</td>
                  <td className={`py-2.5 text-right tabular font-bold ${row.hl ? 'text-gold' : 'text-white/80'}`}>
                    {row.total}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="pl-11 text-white/60 text-xs leading-relaxed space-y-1">
          <p>
            Friction = (fair profit − actual profit) ÷ stake × 100, on a
            winning $100 bet at ~50% probability. Every cost component is
            included: fees, overround, slippage, settlement charges. Nothing
            hidden.
          </p>
          <p>
            <span className="text-white/40">Source: April 2026 live platform screenshots + published fee schedules
            (polymarketexchange.com/fees-hours.html, kalshi.com/fee-schedule).
            Overround measured as sum of buy-side ask prices for all outcomes
            on the same market. </span>
            <span className="text-white/50">Self-check: open any sports market on Polymarket or Kalshi, add both
            sides&apos; ask prices, compare to 100¢. The gap is the overround on
            top of the advertised fee.</span>
          </p>
        </div>

        {/* Why Even Steven wins on friction */}
        <div className="pl-11 text-white/70 text-sm leading-relaxed space-y-4">
          <p className="text-white font-semibold text-base">
            Why Even Steven wins on friction
          </p>
          <p className="text-white/50 text-xs italic">
            Polymarket Global advertises 0.75% for sports. Our fee is 2.00%. On
            a single-cell comparison we look more expensive. On total friction we
            win every row.
          </p>

          <ol className="space-y-3 list-decimal list-inside marker:text-gold/50 marker:font-display">
            <li>
              <strong className="text-white">No order book = no overround.</strong>{' '}
              When you buy &quot;Yes&quot; on one side and someone buys &quot;Yes&quot; on the
              other, the two prices sum to more than $1.00. That excess — typically
              1–9¢ depending on liquidity — goes to market makers. On Even Steven,
              pools sum to exactly 100% of stakes by construction. There is no gap
              because there is no order book and no market maker.
            </li>
            <li>
              <strong className="text-white">Flat fee regardless of size = no slippage.</strong>{' '}
              A $10,000 bet on Polymarket walks the order book from 50¢ to 51¢ as
              it fills. On Even Steven, a $10,000 bet and a $100 bet pay the same
              2% friction. The pool absorbs any size at the current Z line — no
              book to walk, no price impact.
            </li>
            <li>
              <strong className="text-white">Flat friction across every market.</strong>{' '}
              Tuesday MLS, Sunday NFL, niche hockey props — Even Steven charges
              2.00% on all of them. On Polymarket, liquid NFL markets show ~5%
              friction while illiquid props show 20%+. Agents betting on long-tail
              markets — the majority of sports events by count — face dramatically
              higher costs on order book platforms.
            </li>
            <li>
              <strong className="text-white">The fee cannot be raised on you.</strong>{' '}
              Polymarket raised fees three times in 2026: crypto in January, sports
              in February, eight more categories in March.{' '}
              <code className="text-gold/90">FEE_PERCENT</code> is set at deployment
              and is immutable. A strategy backtested at 2% friction stays at 2%
              friction across every market, every time period.
            </li>
          </ol>
        </div>
      </section>

      {/* ── 03. Trustless settlement ─────────────────────────────────────── */}
      <Section id="settlement" number="03" title="Trustless settlement.">
        <p>
          Game results are submitted to{' '}
          <a
            href="https://uma.xyz"
            target="_blank"
            rel="noopener noreferrer"
            className="text-gold underline underline-offset-2"
          >
            UMA&apos;s Optimistic Oracle V3
          </a>{' '}
          via <code className="text-gold/90">assertTruth()</code>. UMA&apos;s
          optimistic model assumes the assertion is correct unless someone
          disputes it with a bond during the{' '}
          <strong className="text-white">~2-hour liveness window.</strong>
        </p>
        <p className="mt-4">
          The dispute window is a{' '}
          <span className="text-white font-medium">feature</span>, not a bug:
          anyone with evidence the result is wrong can challenge it on-chain.
          If unchallenged, it finalizes automatically and payouts open.
        </p>
        <p className="mt-4 text-white/60">
          The owner cannot override outcomes.{' '}
          <code className="text-gold/90">settle()</code> was removed entirely
          in v1.8. Finality is enforced in code, not promised in docs.
        </p>
      </Section>

      {/* ── 03b. No owner override ───────────────────────────────────────── */}
      {/* Correction applied: cancellation refund language per audit S-1 */}
      <Section id="trustless" number="03b" title="No owner override.">
        <p>
          Once a market is deployed, the owner cannot pause it, cancel it
          arbitrarily, or change the fee. The only cancellation path is if
          settlement fails for 7 days, at which point anyone can call{' '}
          <code className="text-gold/90">triggerRefund()</code> — your stake is
          returned in full.
        </p>
        <p className="mt-4 text-white/60">
          The same logic governs legitimate cancellations (e.g., a game that
          does not take place): if a game is cancelled, your stake is refunded
          in full. The 2% fee paid at placement is not refunded — it was already
          collected when you bet. 90-day claim window.
        </p>
      </Section>

      {/* ── 04. Verify everything ────────────────────────────────────────── */}
      {/* Correction applied: audit date March–June 2026 (was March–July) */}
      <Section id="verify" number="04" title="Verify everything.">
        <ul className="space-y-3 text-sm">
          <li>
            <a
              href={`${BASESCAN}/address/${MAIN.factoryV13}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-gold underline underline-offset-2"
            >
              Factory contract on BaseScan
            </a>{' '}
            — source verified, immutable.
          </li>
          <li>
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="text-gold underline underline-offset-2"
            >
              GitHub (MIT license)
            </a>{' '}
            — all contract code is public.
          </li>
          <li>
            <span className="text-white/80">Five audit rounds</span>{' '}
            <span className="text-white/40">
              (Claude Opus, March–June 2026). All critical and high findings
              resolved. Not a formal third-party audit.
            </span>
          </li>
          <li>
            <code className="text-gold/90">getMarketEV(stake, side)</code>{' '}
            <span className="text-white/60">
              — call it yourself on any live market to check the math.
              Payout numbers in this app come directly from this function.
            </span>
          </li>
        </ul>
      </Section>

      {/* ── 05. Edge cases ───────────────────────────────────────────────── */}
      {/* Corrections applied: cancellation and backstop fee language per audit S-1 */}
      <Section id="edge-cases" number="05" title="Edge cases.">
        <dl className="space-y-5 text-sm">
          <div>
            <dt className="text-white font-semibold">Unbalanced pools</dt>
            <dd className="mt-1 text-white/60">
              Early in a market&apos;s life, one side may have more money than
              the other. Payouts float until the pools balance. Your line and
              payout estimate are shown at bet time via{' '}
              <code className="text-gold/90">getMarketEV</code> — they lock the
              moment you confirm the transaction.
            </dd>
          </div>
          <div>
            <dt className="text-white font-semibold">Protocol seed</dt>
            <dd className="mt-1 text-white/60">
              Each market is seeded with 1 USDC per side at deployment.
              This ensures{' '}
              <code className="text-gold/90">getMarketEV</code> returns a
              meaningful number even before any bets are placed.
            </dd>
          </div>
          <div>
            <dt className="text-white font-semibold">Cancellation</dt>
            <dd className="mt-1 text-white/60">
              If a game is cancelled, your stake is refunded in full. The 2%
              fee paid at placement is not refunded — it was already collected
              when you bet. 90-day claim window.
            </dd>
          </div>
          <div>
            <dt className="text-white font-semibold">7-day settlement backstop</dt>
            <dd className="mt-1 text-white/60">
              If a closed market goes 7 days without a settlement assertion,
              any wallet can call <code className="text-gold/90">triggerRefund()</code>.
              Your stake is refunded in full. The 2% fee paid at placement is
              not refunded — it was already collected when you bet. Designed to
              protect bettors if a settlement bot fails.
            </dd>
          </div>
        </dl>
      </Section>

      {/* ── 06. Your funds can't get stuck ──────────────────────────────── */}
      <Section id="recovery" number="06" title="Your funds can't get stuck.">
        <p>
          Three recovery paths exist as structural guarantees in the contract.
          Every path ends in a payout or a stake refund. Nothing can be
          permanently locked.
        </p>

        <ol className="mt-5 space-y-4 list-none">
          <RecoveryPath
            number="1"
            title="Settlement → claim"
            detail={
              <>
                Normal path. Game ends, anyone calls{' '}
                <code className="text-gold/90">requestSettlement(finalSpread)</code>{' '}
                with a USDC bond. After the 2-hour UMA liveness window,{' '}
                <code className="text-gold/90">executeSettlement()</code>{' '}
                finalizes. Winners call{' '}
                <code className="text-gold/90">claimAllPayouts()</code>.
                90-day claim window post-settlement.
              </>
            }
          />
          <RecoveryPath
            number="2"
            title="triggerRefund() — anyone after 7 days"
            detail={
              <>
                If a closed market goes 7 days without a settlement assertion,
                any wallet can call{' '}
                <code className="text-gold/90">triggerRefund()</code>.
                Full stake returned; the 2% placement fee is not refunded
                (it left the contract when you bet). Use{' '}
                <code className="text-gold/90">canTriggerRefund()</code>{' '}
                to check availability.
              </>
            }
          />
          <RecoveryPath
            number="3"
            title="sweepUnclaimed() — protocol after 90 days"
            detail={
              <>
                After 90 days post-settlement or cancellation, any unclaimed
                funds are swept to the protocol wallet. Bettors have 90 days
                to claim — sufficient for any automated agent. The sweep is a
                hygiene function, not a trap: you have a 90-day window before
                it applies.
              </>
            }
          />
        </ol>

        <p className="mt-5 text-white/50 text-xs">
          Source:{' '}
          <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer" className="text-gold/70 underline underline-offset-2">
            SportsbookMarket.sol
          </a>{' '}
          — <code className="text-gold/70">cancelMarket()</code>,{' '}
          <code className="text-gold/70">triggerRefund()</code>,{' '}
          <code className="text-gold/70">sweepUnclaimed()</code>
        </p>
      </Section>

      {/* ── 07. Verified contracts ───────────────────────────────────────── */}
      <Section id="contracts" number="07" title="Verified contracts.">
        <p className="text-sm">
          Base Mainnet — source verified on BaseScan, Exact Match.
        </p>

        {/* Mainnet table */}
        <div className="mt-4 overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0">
          <table className="min-w-[500px] w-full text-xs border-collapse">
            <thead>
              <tr className="border-b border-white/10">
                <th className="text-left py-2 pr-6 font-display font-semibold text-white/50 uppercase tracking-widest">Contract</th>
                <th className="text-left py-2 font-display font-semibold text-white/50 uppercase tracking-widest">Address</th>
              </tr>
            </thead>
            <tbody>
              <ContractRow
                label="SportsbookFactory v1.3"
                addr={MAIN.factoryV13}
                href={`${BASESCAN}/address/${MAIN.factoryV13}`}
              />
              <ContractRow
                label="SportsbookFactory v1.2 (retired)"
                addr={MAIN.factoryV12}
                href={`${BASESCAN}/address/${MAIN.factoryV12}`}
                retired
              />
              <ContractRow
                label="USDC (Circle)"
                addr={MAIN.usdc}
                href={`${BASESCAN}/address/${MAIN.usdc}`}
              />
              <ContractRow
                label="UMA OOV3"
                addr={MAIN.umaOov3}
                href={`${BASESCAN}/address/${MAIN.umaOov3}`}
              />
            </tbody>
          </table>
        </div>

        <p className="mt-3 text-xs text-white/40">
          Deploy tx:{' '}
          <a
            href={`${BASESCAN}/tx/${MAIN.deployTx}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-gold/60 underline underline-offset-2 font-mono"
          >
            {MAIN.deployTx.slice(0, 18)}…
          </a>
        </p>

        {/* Testnet */}
        <p className="mt-6 text-sm text-white/50">
          Base Sepolia (testnet)
        </p>
        <div className="mt-3 overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0">
          <table className="min-w-[500px] w-full text-xs border-collapse">
            <tbody>
              <ContractRow
                label="SportsbookMarket (reference)"
                addr={TESTNET.market}
                href={`${SEPOLIA_BS}/address/${TESTNET.market}`}
              />
              <ContractRow
                label="USDC (Circle testnet)"
                addr={TESTNET.usdc}
                href={`${SEPOLIA_BS}/address/${TESTNET.usdc}`}
              />
              <ContractRow
                label="UMA OOV3"
                addr={TESTNET.umaOov3}
                href={`${SEPOLIA_BS}/address/${TESTNET.umaOov3}`}
              />
            </tbody>
          </table>
        </div>

        <p className="mt-4 text-xs text-white/40">
          Markets deploy per game via the factory. Use{' '}
          <code className="text-gold/70">getOpenMarkets()</code> to discover
          active markets.
        </p>
      </Section>

      {/* ── Back to markets ──────────────────────────────────────────────── */}
      <div className="pt-4 border-t border-white/8">
        <Link href="/" className="btn-ghost text-sm">
          ← Back to markets
        </Link>
      </div>

      {/* ═══════════════════════════════════════════════════════════════════
          DEVELOPER / AGENT ANNEX
          Visually separated — intended for builders and agents, not general
          readers. All code verified against deployed v1.8.1.
      ═══════════════════════════════════════════════════════════════════ */}
      <div className="pt-8 border-t-2 border-gold/20 space-y-8">
        <div className="space-y-1">
          <p className="font-display text-xs font-semibold text-gold/50 tracking-widest uppercase">
            Annex
          </p>
          <h2 className="font-display text-2xl sm:text-3xl font-bold leading-tight">
            For developers &amp; agents.
          </h2>
          <p className="text-white/50 text-sm">
            Even Steven is designed for AI agents. Every market exposes
            machine-readable state through view functions. No UI required.
            Full reference:{' '}
            <a
              href={AGENTS_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="text-gold underline underline-offset-2"
            >
              AGENTS.md on GitHub
            </a>
            .
          </p>
        </div>

        {/* Quick Start */}
        <div className="space-y-3">
          <h3 className="font-display text-base font-semibold text-white/80 uppercase tracking-wider">
            Quick Start
          </h3>
          <CodeBlock lang="javascript">{`// 1. Find open markets
const markets = await factory.getOpenMarkets();

// 2. Evaluate a market (payouts are gross of the 2% placement fee)
const [gameId, z, gPool, lePool, tPool, isOpen] = await market.getMarketState();
const [currentPayout, liquidPayout, impliedVig] = await market.getMarketEV(stake, greaterThan);

// 3. Approve and bet (the contract pulls stake + 2% fee)
await usdc.approve(marketAddress, ethers.MaxUint256);
await market.placeBet(greaterThan, stake);

// 4. Claim after settlement
await market.claimAllPayouts();`}</CodeBlock>
        </div>

        {/* Discovery */}
        <div className="space-y-3">
          <h3 className="font-display text-base font-semibold text-white/80 uppercase tracking-wider">
            Discovery
          </h3>
          <CodeBlock lang="solidity">{`// Find all open markets
address[] memory markets = factory.getOpenMarkets();

// Get full snapshot of a market
(
    string memory gameId,
    bool isOpen,
    bool isSettled,
    bool isCanceled,
    int256 currentZ,
    uint256 totalPool,
    int256 spreadMax,
    int256 spreadMin,
    uint256 feePercent,
    bool refundAvailable
) = factory.getMarketInfo(marketAddress);

// Look up a market by game ID (public mapping getter)
address market = factory.marketByGameId("NFL-2026-01-15-HOME-Chiefs-AWAY-49ers");`}</CodeBlock>
        </div>

        {/* Pre-bet evaluation */}
        <div className="space-y-3">
          <h3 className="font-display text-base font-semibold text-white/80 uppercase tracking-wider">
            Pre-bet evaluation
          </h3>
          <CodeBlock lang="solidity">{`// Get current state
(
    string memory gameId,
    int256 z,          // current Z line, 4-decimal: -35000 = -3.5
    uint256 gPool,     // stakes on greaterThan side
    uint256 lePool,    // stakes on lessEqual side
    uint256 tPool,     // total pool (stakes only, fees never enter)
    bool isOpen,
    bool isSettled
) = market.getMarketState();

// Evaluate EV before betting (payouts are gross of the 2% placement fee)
(
    uint256 currentPayout,  // gross return at current pool state
    uint256 liquidPayout,   // gross return at balanced pools (~$200 on $100 stake)
    uint256 impliedVig      // protocol fee in bps — 200 = 2%
) = market.getMarketEV(stake, greaterThan);

// Kelly criterion note:
// liquidPayout / stake = gross multiplier at liquidity (~2.0)
// True cost basis     = stake * (1 + impliedVig / 10000)  // 2% fee on stake
// Opportunity check   : currentPayout > liquidPayout → early imbalance favors you
// Net EV              = (probability * currentPayout) - stake - (stake * impliedVig / 10000)`}</CodeBlock>
        </div>

        {/* Approve + bet */}
        <div className="space-y-3">
          <h3 className="font-display text-base font-semibold text-white/80 uppercase tracking-wider">
            Approve and bet
          </h3>
          <CodeBlock lang="solidity">{`// Always use max approval — Circle USDC on Base rejects exact-amount approvals.
// Max approval covers stake + 2% fee in one go.
usdc.approve(marketAddress, type(uint256).max);

// greaterThan = true  → betting finalSpread * 10000 > lockedZ
// greaterThan = false → betting finalSpread * 10000 <= lockedZ
market.placeBet(greaterThan, stake); // minimum 1 USDC = 1_000_000`}</CodeBlock>
        </div>

        {/* Claim */}
        <div className="space-y-3">
          <h3 className="font-display text-base font-semibold text-white/80 uppercase tracking-wider">
            Claim
          </h3>
          <CodeBlock lang="solidity">{`// After MarketSettled event fires:
market.claimAllPayouts(); // claims all your bets in one transaction

// Or claim a specific bet by ID:
market.claimPayout(betId);

// 90-day claim window — after that, sweepUnclaimed() moves funds to the protocol`}</CodeBlock>
        </div>

        <p className="text-xs text-white/30 pt-2">
          Full function reference, strategy notes, and event subscriptions:{' '}
          <a
            href={AGENTS_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="text-gold/50 underline underline-offset-2"
          >
            AGENTS.md
          </a>
          . Protocol version: v1.8.1. Audited by Claude Opus, five rounds,
          March–June 2026.
        </p>
      </div>

    </main>
  )
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function Section({
  id,
  number,
  title,
  children,
}: {
  id: string
  number: string
  title: string
  children: React.ReactNode
}) {
  return (
    <section id={id} className="scroll-mt-20 space-y-4">
      <header className="flex items-baseline gap-3">
        <span
          className="font-display text-xs font-semibold text-gold/50 tracking-widest uppercase tabular w-8 shrink-0"
          aria-hidden
        >
          {number}
        </span>
        <h2 className="font-display text-2xl sm:text-3xl font-bold leading-tight">
          {title}
        </h2>
      </header>
      <div className="pl-11 text-white/70 leading-relaxed space-y-0">{children}</div>
    </section>
  )
}

function Row({
  label,
  value,
  bold,
  className = '',
}: {
  label: string
  value: string
  bold?: boolean
  className?: string
}) {
  const cls = `flex justify-between gap-4 ${bold ? 'text-white font-semibold' : 'text-white/60'} ${className}`
  return (
    <div className={cls}>
      <span>{label}</span>
      <span className="tabular">{value}</span>
    </div>
  )
}

function RecoveryPath({
  number,
  title,
  detail,
}: {
  number: string
  title: string
  detail: React.ReactNode
}) {
  return (
    <li className="flex gap-3 text-sm">
      <span className="shrink-0 w-6 h-6 rounded-full border border-gold/30 flex items-center justify-center font-display font-bold text-xs text-gold/70 tabular mt-0.5">
        {number}
      </span>
      <div>
        <p className="font-semibold text-white">{title}</p>
        <p className="mt-1 text-white/60">{detail}</p>
      </div>
    </li>
  )
}

function ContractRow({
  label,
  addr,
  href,
  retired = false,
}: {
  label: string
  addr: string
  href: string
  retired?: boolean
}) {
  return (
    <tr className="border-b border-white/5">
      <td className={`py-2 pr-6 ${retired ? 'line-through text-white/30' : 'text-white/70'}`}>
        {label}
      </td>
      <td className={`py-2 font-mono ${retired ? 'text-white/20' : ''}`}>
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className={retired ? 'text-white/20' : 'text-gold/70 hover:text-gold underline underline-offset-2'}
        >
          {addr.slice(0, 10)}…{addr.slice(-6)}
        </a>
      </td>
    </tr>
  )
}

function CodeBlock({ lang, children }: { lang: string; children: string }) {
  return (
    <div className="relative">
      <span className="absolute top-2.5 right-3 text-[10px] font-display font-semibold text-white/20 uppercase tracking-widest select-none">
        {lang}
      </span>
      <pre className="bg-[#0d0d0d] border border-white/8 rounded-lg p-4 text-xs text-white/75 overflow-x-auto leading-relaxed font-mono">
        <code>{children}</code>
      </pre>
    </div>
  )
}
