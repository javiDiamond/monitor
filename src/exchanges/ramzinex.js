'use strict';

/**
 * رمزینکس (ramzinex.ir) — adapter.
 *
 * Market 11 is USDT/IRR. Two places are read, and a price in EITHER one counts
 * as a breach:
 *
 *   1. the headline "قیمت تتر" block in .market-overview
 *   2. the market carousel item for this pair
 *
 * Order-book rows and recent-trades rows are deliberately NOT read: they are
 * trading data rather than a displayed price quote.
 *
 * This page quotes in ریال, not تومان, so values are labelled as IRR.
 *
 * ---- three things about this site that cost real investigation ----
 *
 * 1. THE TITLE IS REPORTED BUT NEVER JUDGED. رمزینکس puts the price in the
 *    browser tab's own title (`2,678,500 IRR | رمزینکس تریدر | تتر`), which no
 *    element probe can see. `pageTitle` therefore rides up as a SEPARATE field,
 *    never as a probe: `sampleOnce` computes its `any` from `snap.probes` alone,
 *    so a title carrying a price cannot flip a verdict. describe.js turns it
 *    into a sentence and a read-only row. Its honest limitation: a page
 *    screenshot can never evidence the browser tab, so this finding has no image
 *    behind it.
 *
 * 2. THE PAGE WEDGES ITS OWN RENDERER ON ROUGHLY HALF ITS LOADS. It begins a
 *    client-side navigation ~3.5s in and, about half the time, never completes
 *    it: `page.evaluate` and `page.screenshot` both stop answering permanently,
 *    at 1% CPU. Measured over 10 runs from this host, 6 never rendered at all.
 *    Nothing here can prevent that, so the scraper bounds every in-page
 *    operation (config.evaluateTimeoutMs) and this check reports «نامشخص»
 *    within its own budget instead of hanging until checkTimeoutMs and being
 *    filed as `check_error`.
 *
 * 3. THE ISLAND RENDERS LATE, AND ONLY WHEN IT RENDERS AT ALL. Measured from
 *    `goto`: domcontentloaded 1.4-2.2s; `.market-overview` present and its price
 *    slot filled 7.9-11.7s (n=14 observations, those that rendered at all). The
 *    ceiling below covers the slowest observed run with ~30% headroom, and
 *    settleMs + readyTimeoutMs + navP95 = 4 + 15 + 2.2 = ~21s sits far inside
 *    the 120s checkTimeoutMs.
 */
module.exports = {
  id: 'ramzinex',
  name: 'رمزینکس',
  host: 'ramzinex.ir',
  coin: 'USDT',
  market: 'USDT_IRR',
  marketId: 11,
  unit: 'IRR',
  unitLabel: 'ریال',
  url: 'https://ramzinex.ir/app/markets/11/spot/',
  currency: 'IRR',

  // The headline block is the last thing on this page to render, behind a heavy
  // client-side island, so `settleMs` (4s) expires long before it appears.
  // `settleMs` is the wrong budget for that anyway: sampleOnce records nothing
  // until the probe is ready, so more settle time cannot help. Env-tunable
  // because the render time is a property of the site, not of this monitor.
  readyTimeoutMs: Number(process.env.RAMZINEX_READY_TIMEOUT_MS || 15_000),

  api: {
    // Public and unauthenticated. data[0] is the most recent trade; its first
    // element is the price in ریال.
    url: 'https://publicapi.ramzinex.ir/exchange/api/v1.0/exchange/orderbooks/11/trades?duration=24h',
    parse(text) {
      const json = JSON.parse(text);
      const rows = (json && json.data) || [];
      if (!Array.isArray(rows) || !rows.length) return null;
      const price = Number(rows[0][0]);
      return {
        price: Number.isFinite(price) ? price : null,
        change: null,
        // ریال -> تومان, so prices are comparable with the other exchanges.
        unitScale: 0.1,
      };
    },
  },

  probeInPage({ marketId }) {
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const id = marketId || 11;

    // This probe runs many times per page load; clear earlier tags first so the
    // visibility check can never match more than one element per key.
    document.querySelectorAll('[data-probe]').forEach((el) => {
      el.removeAttribute('data-probe');
    });

    const isNumeric = (t) => /^[\d۰-۹٠-٩.,٬\s]+$/.test(t) && /[\d۰-۹٠-٩]/.test(t);

    /* ---- headline: the block captioned "قیمت تتر" ---- */
    let headlineRaw = null;
    let headlineBlock = null;
    const overview = document.querySelector('.market-overview');
    if (overview) {
      for (const el of overview.querySelectorAll('div.flex-col-start-between')) {
        const cap = el.querySelector('span');
        if (cap && norm(cap.textContent) === 'قیمت تتر') {
          headlineBlock = el;
          const ps = [...el.querySelectorAll('p')].map((p) => norm(p.textContent)).filter(Boolean);
          headlineRaw = ps.length ? ps[0] : null;
          break;
        }
      }
    }

    /* ---- carousel: the market list item for this pair ---- */
    // Verified against the live page, not just the fixture: 60 `a.slide-item`
    // anchors are present and two of them match this market's path.
    const path = `/app/markets/${id}/spot`;
    const candidates = [...document.querySelectorAll('a.slide-item')].filter((a) =>
      (a.getAttribute('href') || '').includes(path)
    );

    // The price span shares its class with a long warning sentence, so pick by
    // content rather than by class.
    const priceOf = (a) => {
      const nums = [...a.querySelectorAll('span')]
        .map((s) => norm(s.textContent))
        .filter(isNumeric);
      return nums.length ? nums[nums.length - 1] : null;
    };
    const onScreen = (a) => {
      const r = a.getBoundingClientRect();
      return r.right > 0 && r.left < window.innerWidth;
    };

    // The market strip is an auto-scrolling marquee (a 270s `slide` animation)
    // inside an overflow:hidden track, so at any instant the tether chip may be
    // scrolled out of sight. We read the page exactly as it loads and never
    // pause, scroll or otherwise alter it, so the verdict reflects what a user
    // would actually see at that moment.
    const priced = candidates.map((a) => ({ el: a, raw: priceOf(a) })).filter((c) => c.raw);
    const chosen =
      priced.find((c) => onScreen(c.el)) ||
      priced.slice().sort((a, b) => a.el.getBoundingClientRect().left - b.el.getBoundingClientRect().left)[0] ||
      null;
    const item = chosen ? chosen.el : candidates[0] || null;
    const carouselRaw = chosen ? chosen.raw : null;

    // Tag both surfaces for the visibility check.
    if (headlineBlock) headlineBlock.dataset.probe = 'headline';
    if (item) item.dataset.probe = 'carousel';

    /* ---- is the market strip actually rendered? ----
       Verified live: two `.markets-container` elements exist on a loaded page,
       and the strip holds `a.slide-item` chips for every market. So feedLive
       requires BOTH the overview and a populated strip rather than resting on
       one class name. Presence only — deliberately NOT "a chip shows a real
       price": this site briefly paints the headline at "0" before filling it,
       and demanding a non-zero value here would mark a merely-still-loading
       page as stalled and report «نامشخص» for a page that is about to show the
       price. */
    const strip = document.querySelector('.markets-container');
    const feedLive =
      !!overview &&
      !!strip &&
      strip.querySelectorAll('a.slide-item').length > 0 &&
      document.readyState !== 'loading';

    return {
      ready: !!overview,
      feedLive,
      // Separate field, never a probe. See the header note.
      pageTitle: document.title || null,
      probes: [
        { key: 'headline', label: 'قیمت تتر (بالای صفحه)', raw: headlineRaw, primary: true },
        { key: 'carousel', label: 'بازار معاملاتی', raw: carouselRaw, primary: false },
      ],
    };
  },
};