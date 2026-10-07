'use strict';

/**
 * Central configuration. Every value can be overridden with an env var so the
 * app can be tuned without touching code. Exchange-specific details (URLs,
 * selectors, API endpoints) live in src/exchanges/.
 */
module.exports = {
  port: Number(process.env.PORT || 3000),

  // Compliance policy. 'hidden' = the platforms have been instructed to stop
  // showing this price, so a hidden price is CORRECT and a visible price is a
  // VIOLATION. 'shown' inverts both meanings.
  expect: process.env.EXPECT || 'hidden',

  checkIntervalMs: Number(process.env.CHECK_INTERVAL_MS || 1_800_000),
  navTimeoutMs: Number(process.env.NAV_TIMEOUT_MS || 60_000),

  /* A hard ceiling on one exchange's WHOLE check — navigation, settle window,
     confirm window and screenshot capture combined. Playwright's own
     page.evaluate has no timeout, so a page that locks its main thread would
     otherwise hold `running` true forever and silently stall every exchange.
     120 s leaves generous headroom over the ~10 s a healthy check takes. */
  checkTimeoutMs: Number(process.env.CHECK_TIMEOUT_MS || 120_000),

  // How long to keep sampling a page before judging it. Exchanges render the
  // real price first and blank it out shortly after, so a single early read
  // would produce false violations. Measured flash duration for the exchanges
  // we watch tops out around 1.6s, so this leaves roughly 2.5x margin.
  settleMs: Number(process.env.SETTLE_MS || 4_000),
  sampleMs: Number(process.env.SAMPLE_MS || 350),

  /* Playwright's page.evaluate has NO timeout of its own. A page that locks its
     own main thread — which رمزینکس does on roughly half of its loads, wedging
     mid-navigation — therefore hangs the evaluate forever, and the check sits on
     the 120s `checkTimeoutMs` ceiling and is then reported as `check_error`.
     Measured: 4 of 5 consecutive ramzinex.ir checks burned the full budget and
     produced nothing, while the very same page rendered its price moments later
     on a fresh load.

     Every in-page evaluation is therefore raced against this ceiling. A sample
     that loses the race is DISCARDED exactly like one whose visibility check
     failed — it is not evidence, and the verdict stays «نامشخص». 3s is ~8x the
     cost of a healthy sample (5-40ms) while still leaving room for a slow one. */
  evaluateTimeoutMs: Number(process.env.EVALUATE_TIMEOUT_MS || 3_000),

  /* A surface can render its frame and THEN fill in. رمزینکس paints
     `.market-overview` with the headline slot at "0" and swaps in the real
     number up to ~1.8s later (measured n=3, 0-1805ms). Because Phase 1b only
     runs while the probe is not yet ready, and Phase 2 only runs once a price
     has been seen, that window fell through every phase and the check judged
     the half-filled page — reporting «رعایت شده» with a price on screen. After
     ready, sample this long more if nothing is priced yet. Fail-closed: it can
     only ever find MORE evidence, never remove any. */
  fillTimeoutMs: Number(process.env.FILL_TIMEOUT_MS || 3_000),
  // Timeout for the plain-HTTP path used by server-rendered exchanges, which
  // are read without a browser.
  fetchTimeoutMs: Number(process.env.FETCH_TIMEOUT_MS || 25_000),
  // If a price is STILL on screen after the settle window, watch this long
  // more before calling it a violation. How late the blanking happens varies
  // with page weight and connection speed, so a fixed settle window alone
  // would occasionally report a flash as a real breach.
  confirmMs: Number(process.env.CONFIRM_MS || 5_000),

  headless: process.env.HEADLESS !== 'false',
  // 'msedge' uses the locally installed Edge; falls back to bundled Chromium.
  browserChannel: process.env.BROWSER_CHANNEL || 'msedge',

  historyLimit: Number(process.env.HISTORY_LIMIT || 400),

  // Evidence screenshots kept per exchange for the /screenshots gallery. 20
  // exchanges × 10 × ~100-400KB of WebP ≈ tens of MB.
  shotsPerExchange: Number(process.env.SHOTS_PER_EXCHANGE || 10),

  // Optional: POST a JSON payload whenever the compliance state changes.
  webhookUrl: process.env.WEBHOOK_URL || '',
};