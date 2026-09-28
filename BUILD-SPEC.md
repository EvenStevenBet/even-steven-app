# EVEN STEVEN WEB APP — BUILD SPEC
### This document is your build prompt. Read it fully before writing any code.

You are building the production web app for Even Steven, a live, five-times-audited parimutuel sports betting protocol on Base mainnet. The contracts are deployed and immutable — you will not write or modify any Solidity. Your job is the frontend: a Next.js app that is simultaneously a normal website, a Base Mini App, and a Farcaster Mini App, launching before NFL preseason.

The #1 priority is distribution and conversion. Every decision below was made deliberately. Where this spec is explicit, follow it exactly. Where it is silent, make the simple choice and leave a `// DECISION:` comment.

---

## 0. Hard rules — violations are bugs

1. **Fee language.** The fee is a **2% taker fee on the stake, charged upfront at bet placement**. To bet $100 you pay $102: $100 stake + $2 fee. Only the stake enters the pool. At liquidity a $100 stake pays **exactly** $200 gross on a win (**exactly** $98 net profit after fee) — this is exact, not an approximation a thin pool merely approaches. There is NO settlement fee, NO "4% friction," NO fee at claim time. If you encounter old docs or comments using settlement-fee framing, they are stale — the deployed v1.8.1 contract source is the only authority.
2. **Never hand-write the ABI from memory.** Generate ABIs from the contract source files in this workspace: `SportsbookMarket-v1_8_1.sol` and `SportsbookFactory-v1_3.sol`. These match deployed bytecode.
3. **Payout numbers shown to users must be settlement-accurate.** Prefer the contract's own `getMarketEV`/`simulatePayout` over reimplementing math client-side — **except** for the one known case where those functions themselves are wrong: their denominator counts the 1 USDC protocol seed as a competing stake, under-quoting versus real settlement (worst on thin pools). `lib/payout.ts` (commit 4251c87) reimplements their exact formula with that one correction applied — use it instead of calling `getMarketEV`/`simulatePayout` directly. Do not reimplement payout math beyond that one documented fix.
4. **No market-creation UI.** Do not build any interface that calls `createMarket` — deliberate omission (fee routing unresolved at contract level).
5. **Read `CLAUDE.md` in this workspace before starting.** It is the canonical fact sheet (addresses, formats, conventions).
6. Commit to git frequently — after each working milestone, not at the end.

---

## 1. Stack & setup

- **Next.js 14+ (App Router) + React + TypeScript**, Tailwind CSS
- **wagmi + viem** for all chain interaction
- **Base MiniKit / OnchainKit** for Mini App manifest + Base App integration
- **Coinbase Smart Wallet** as the featured connector; injected (MetaMask) and WalletConnect as fallbacks
- Hosting: **Vercel**. RPC: **Alchemy** (key via env)
- No database beyond the Upstash store (relay abuse protection and attribution records, §7). No backend beyond Next.js API routes. No localStorage for anything critical.

**Before building the manifest and Smart Wallet flows, consult the current docs** (docs.base.org — MiniKit, Mini App manifest spec, Paymaster). Naming has churned recently: Farcaster "Frames v2" was renamed **Mini Apps**, and Base App + Farcaster now share the manifest spec. Do not build against the deprecated `@farcaster/frame-sdk` Frames-v2 patterns from older tutorials.

## 2. Network config — env vars only

All chain-specific values come from environment variables so the app flips between Base Sepolia (testing) and Base mainnet (production) with zero code changes:

```
NEXT_PUBLIC_CHAIN=base | baseSepolia
NEXT_PUBLIC_FACTORY_ADDRESS=        # mainnet: 0x5906370b9831728ec523b647137a1bbf0ab45390 (v1.6)
NEXT_PUBLIC_USDC_ADDRESS=           # mainnet: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
NEXT_PUBLIC_ALCHEMY_KEY=
NEXT_PUBLIC_PAYMASTER_URL=          # Coinbase Developer Platform paymaster endpoint
NEXT_PUBLIC_MARKETS_CSV_URL=        # raw GitHub CSV, written by market-opener-bot
NEXT_PUBLIC_APP_URL=                # canonical deployed URL, for share links + manifest
```

Never use the retired factory v1.2 (`0x08BA5624107536d1CEA043B372978E7e9516E214`).

## 3. Data architecture: sheet + chain

**The market display list comes from a published Google Sheet (CSV). Live market data comes from the chain.** This is what lets the app show upcoming games weeks before their contracts exist.

Sheet columns: `gameId, sport, homeTeam, awayTeam, gameDate, status, marketAddress, openLine, bettingOpensAt, notes`

Rules:
- Fetch the CSV server-side with ~60s revalidation; parse with papaparse. Commit a `/data/markets.json` fallback used if the fetch fails, so the site never renders empty on a sheet outage.
- `marketAddress` empty → **coming-soon card**: matchup + game date + "Betting opens [date]". No line, no bet button, no payout anything.
- `marketAddress` present → **live card**: read line and state from the contract. The sheet's `openLine` is display fallback only; the chain wins on any conflict.
- Parse team names for display from `gameId` format `SPORT-YYYY-MM-DD-HOME-TeamName-AWAY-TeamName` (MLB doubleheaders append `-G1`/`-G2`) — but prefer the sheet's `homeTeam`/`awayTeam` columns when present.

## 4. Contract integration facts (verified against v1.8.1 source)

- `placeBet(bool greaterThan, uint256 stake)` — pulls `stake + fee` in one `transferFrom`, where `fee = stake × FEE_PERCENT / 10000` (FEE_PERCENT = 200 → 2%). Minimum stake 1 USDC (`1e6`). USDC has 6 decimals.
- `getMarketEV(uint256 stake, bool greaterThan)` → `(currentPayout, liquidPayout, impliedVig)`. Payouts are **gross** (include stake back) and already need no fee deduction — the fee was paid at placement.
- `simulatePayout(uint256 stake, bool greaterThan)` → same payout math, single value.
- `claimPayout(uint256 betId)` / `claimAllPayouts()` — pull pattern; winners claim.
- `getBet(uint256 betId)` → Bet struct (bettor, stake — stake only, fee not stored — greaterThan, lockedZ, claimed status).
- **Enumerating a user's bets:** check the `BetPlaced` event declaration in the source — `BetPlaced(bettor, betId, stake, fee, greaterThan, lockedZ)`. If `bettor` is indexed, filter logs by it; if not, pull the market's `BetPlaced` logs and filter client-side (fine at launch scale). Scan only markets listed in the sheet.
- **Z values are 4-decimal fixed-point:** `-35000` displays as `-3.5`. `lockedZ` is the line a bet settles against; `currentZ` is the live line. `finalSpread` is a whole integer, positive = home team won by that margin.
- **USDC approval (EOA path):** Circle USDC on Base intermittently rejects exact-amount approvals. Flow: check allowance → if insufficient, approve `type(uint256).max` → then bet. Never approve exact amounts.
- Market lifecycle for status display: **open** (accepting bets) → **closed / awaiting settlement** (game over; UMA assertion in its ~2-hour liveness window) → **settled** (payouts claimable). Also possible: **cancelled** (every stake refunded in full, 90-day claim window) and **refund mode** (anyone can `triggerRefund()` if a closed market goes 7 days unsettled — every stake refunded in full). In both, the 2% fee is not refunded: it was collected at placement.
- Factory: use its view functions (e.g. `getMarketInfo(address)`) for per-market metadata; check the v1.6 source for exact signatures.

## 5. Wallet layer & one-tap betting

Support three contexts from day one — standalone browser, Base App in-app, Farcaster Mini App — via a `usePlatformLaunch()` hook that detects context (MiniKit context for Base App/Farcaster; default browser). Type its return as `'browser' | 'baseApp' | 'farcaster' | 'telegram'` — Telegram is a future branch; structure for it, don't implement it.

**Betting paths:**
- **Smart Wallet (featured):** batch approve+bet in a single user confirmation via EIP-5792 (`useSendCalls` / wagmi's batching with `capabilities.paymasterService` pointed at `NEXT_PUBLIC_PAYMASTER_URL`). Result: one tap, no Base ETH needed.
- **EOA fallback (MetaMask etc.):** allowance check → max approve if needed → bet. Two clear steps with progress states.

Keep all bet/claim logic wallet-agnostic behind wagmi so future connectors slot in without touching business logic.

## 6. Pages

Persistent header: logo (file `evenstevenlogogold.png` in workspace), nav (Markets · My Bets · How It Works), Connect Wallet button. Fully responsive — most Mini App traffic is mobile ~380px.

### 6.1 Home / Market List (`/`)
- Hero: **"Bet $100, win $100."** Subline: "No house. No overround. Winners split 100% of the pool." Fee line: **"2% fee."** Nothing else — no payout math in the hero.
- Market cards: matchup, game date/close time, current line (live markets) or "Betting opens [date]" (coming soon). **No pool sizes, no payout estimates, no EV numbers on cards** — deliberate; numbers appear only on the bet slip.
- Live cards → market detail. Coming-soon cards are not clickable (or open a lightweight detail with the same coming-soon state).
- Trust strip (compact, above the fold on desktop, below cards on mobile): "Verified on BaseScan · Open source (MIT) · Settled by UMA oracle · No owner override" — each linking out (BaseScan contract page, GitHub repo, How It Works anchors).
- Empty/pre-season state is a first-class design: if no live markets, the coming-soon grid + trust strip + How It Works link must make the page feel *imminent*, never dead.

### 6.2 Market Detail / Bet Slip (`/market/[gameId]`)
- Matchup header, game time, close countdown, current line, market status.
- Side selector (home/away framed via the line), stake input (USDC).
- On stake input, call `getMarketEV` and render the **honest decomposition**:
  - Stake: $100.00
  - Fee (2%): $2.00
  - **Total cost: $102.00**
  - Payout if you win (at liquidity): $200.00 exactly · (current: from `currentPayout`)
  - **Net profit: $98.00 exactly**
- Show the locked line plainly: "Your line locks at −3.5 when you bet."
- Place Bet button → Smart Wallet one-tap or EOA two-step per §5, with pending/confirmed/failed states and the Basescan tx link.
- Post-bet confirmation includes the **Share** action (§7): X, Farcaster and copy link, pointing at the Tail/Fade page for that bet.
- If market is awaiting settlement: explain the window in plain language — "Game over. The result was submitted to UMA's oracle and can be challenged for ~2 hours. If unchallenged, it finalizes and payouts open." Never let this state look broken.

### 6.3 My Bets (`/bets`)
- Requires connected wallet; graceful connect prompt otherwise.
- Sections: **Active** (matchup, side, stake, locked line vs current line) · **Awaiting settlement** (with the 2-hour explanation) · **Claimable** (payout amount + Claim button; offer `claimAllPayouts` when >1) · **History** (settled/claimed, won/lost, refunded).
- Post-win share action on won bets (§7).

### 6.4 How It Works (`/how-it-works`)
Written for a skeptical crypto-native reader. Order:
1. **Even betting** — what parimutuel means: winners split losers' stakes, true 1:1, "the house is the hidden cost, we removed it."
2. **The fee, honestly** — 2% on stake, upfront, once; the $102 → $200 → $98 walk-through; fee never touches the pool; `FEE_PERCENT` immutable per market.
3. **Trustless settlement** — UMA optimistic oracle, `assertTruth()`, the ~2-hour dispute window as a *feature*; `settle()` removed, no owner override, enforced in code not promised in docs.
4. **Verify everything** — BaseScan links (factory + a sample market), GitHub (MIT), audit history (five rounds, honest note that it's not a formal third-party audit), `getMarketEV` as the "check my math" function.
5. **Edge cases** — early/unbalanced pools (payouts float until liquidity; your line locks at bet time), cancellations (stake refunded in full; the 2% fee is not refunded, it was collected at placement), the 7-day refund backstop.
Source copy facts from README.md in the workspace — do not invent numbers.

## 7. Share-a-bet, builder codes and points (the viral loop)

Revised Sept 2026. The original "no referral tracking, no points, no database" rule is superseded. Everything below is off-chain; no contract changes.

**Share cards (Tail / Fade)**
- Every bet has a share page, `/bet/<marketAddress>/<betId>`. It shows the teams, the pick, and the locked line in plain English. That text is the same `lineSentence` the bet slip prints, derived with the `m = floor(z) + 1` rule and with the team name attached. It also shows the current line, a pool balance meter (the primary visual), and a secondary "if [team] covers, at current pools" multiple: distributable pool / that side's stakes, seed excluded. Never claim a thin pool pays 2×.
- The image comes from `/api/og/bet?market=&betId=`: 1200×630 for X/OG, or `&aspect=3:2` for the `fc:miniapp` embed. Brand colors are black `#0a0a0a`, gold `#f5c842` and white.
- **Tail** (same side) and **Fade** (other side) link to `/market/<gameId>?side=home|away&ref=<ref>`. The ref is the sharer's builder code if they have one, else their wallet address. `/market/<address>` 308-redirects to the gameId URL, keeping the query string.
- Share triggers: after every successful bet, on active bets in My Bets, and on won bets. Each offers X intent, Farcaster (Mini App SDK `composeCast` inside Farcaster/Base App, the web composer elsewhere) and copy link. The page must work without wallet JS in X's in-app browser.

**Refs and builder codes**
- A ref is an approved builder code (lowercase `[a-z0-9-]{3,32}`, `approved: true` in `data/builders.json`), which earns 30% of the fee plus referral points, or any wallet address, which earns referral points only. A ref that pays the bettor is dropped (no self-referral).
- Refs travel on-chain as an ERC-8021 schema-0 calldata suffix appended to `placeBet` (web: both the Smart Wallet batch and EOA paths) or `placeBetFor` (relay, from `ref` in the `POST /api/bet` body). The market ignores trailing calldata.
- Attribution records: one per txHash in Upstash (`attr:tx:<hash>`, SET NX, no TTL, indexed in `attr:index`). The relay writes its record after its success checks pass. Web bets POST `{ txHash }` to `/api/attribution`, which requires exactly one `BetPlaced` from a Factory v1.6 market and reads the ref from the transaction's own calldata, never from the request body.
- The weekly builder report (30% of fee, `BUILDER_SHARE_BPS`) runs in the private `even-steven-ops` repo. Nothing is transferred automatically.

**Points v0**
- A ledger, not a token. The rates are 100 points per USDC staked (to the bettor, win or lose) and 50 per USDC staked by bets a ref brought in, set by `POINTS_PER_USDC` and `REF_POINTS_PER_USDC`.
- `even-steven/scripts/points.mjs` runs hourly and commits `data/points.json`. The app shows a top 50 at `/points` and "Your points" on `/bets`.

## 8. Mini App manifest

- Serve the shared Base/Farcaster manifest at the well-known path per current docs (verify exact path + fields at docs.base.org — this spec deliberately doesn't pin them because the spec has been moving).
- Category/tags: sports/betting-relevant for Base App discovery.
- Generate icon + splash from the logo per the asset requirements.
- `accountAssociation` (domain-ownership signature) is a **manual step for the owner** — scaffold with a placeholder and add it to the manual checklist (§11).

## 9. Design direction

Brand tokens: background near-black `#0a0a0a`, primary accent gold `#f5c842`, white text, green `#00e676` strictly for win/positive states. Logo: black circle, gold equals sign, "EVEN STEVEN" wordmark.

- The **equals sign is the signature motif** — use it structurally (dividers, the balance of two sides of a bet, the "=" in Even Steven) rather than as decoration. One memorable signature element; keep everything else quiet and disciplined.
- This is a sportsbook ticket, not a SaaS dashboard: draw from betting-slip vernacular (stub edges, line notation, ticket typography) without kitsch.
- Typography: pick a characterful display face (used sparingly — hero, matchups) paired with a clean body face; tabular numerals for all money and lines. Do not ship a generic near-black-plus-acid-accent template look; the gold must feel like a choice.
- Copy voice everywhere: short, punchy, specific. Numbers do the talking. No "seamless," "unlock," "empower," no exclamation points. Buttons say exactly what happens: "Place bet — $102 total."
- Quality floor: responsive to 380px, visible keyboard focus, respects reduced motion.

## 10. Build order

**Stage 1 — ship first (no live markets needed):** scaffold, env config, sheet pipeline + coming-soon cards, Home, How It Works, header/wallet connect (all three contexts), manifest scaffold, OG images, Vercel-ready. **Stop at a deployable checkpoint** — Stage 1 goes live while preseason markets don't exist yet.

**Stage 2 — betting flow (test on Base Sepolia via env flip):** Market Detail/bet slip with contract reads, Smart Wallet batched bet + Paymaster, EOA fallback, My Bets + claims, share-a-bet, settlement-window states.

Definition of done, Stage 2: on Sepolia — place a bet via Smart Wallet path (one confirmation, gas sponsored), via MetaMask path (max-approve then bet), see it in My Bets, see correct payout decomposition matching `getMarketEV`, claim after settlement, share link unfurls with the OG image.

## 11. Manual steps for the owner (surface these as a checklist at the end, do not attempt them)

1. Create/link GitHub repo ↔ Vercel; set env vars in Vercel.
2. Alchemy account + API key.
3. Coinbase Developer Platform: create Paymaster, whitelist the market contracts, fund/limit it, get the URL.
4. Create + publish the Google Sheet (CSV) with the schema in §3.
5. Sign the manifest `accountAssociation` for the production domain.
6. Point the domain (evensteven.bet or app subdomain) at Vercel.
7. Submit/verify the Mini App for Base App discovery once live.

## 12. Non-goals for this build

Market creation UI · referral points/leaderboard · any database · Telegram SDK (structure for it, don't build it) · settlement bot · price-history charts · anything requiring the retired v1.2 factory.
