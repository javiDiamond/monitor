'use strict';

/**
 * عصر تتر (asretether.com) — adapter.
 *
 * Monitored page: https://asretether.com/price/usdt
 *
 * A price-reference site rather than an exchange dashboard, and the first page
 * here whose price exists twice on purpose. It conceals nothing: no filter, no
 * opacity, no mask, no clip-path, no blur on or above either copy, and the
 * whole page is server-rendered, so there is no hydration race to wait out.
 *
 * TWO COPIES, EXACTLY ONE VISIBLE AT ANY WIDTH.
 *
 *   card 1   `xl:hidden`      hidden at >=1280px
 *   card 2   `max-xl:hidden`  hidden below 1280px
 *
 * Both are in the DOM at all times with byte-identical inner markup. Verified
 * live at two widths: at 1440px card 1 computes to a zero-size box under a
 * `display:none` ancestor while card 2 is on screen; at 900px they swap, card 1
 * on screen and card 2 zero-size.
 *
 * That is why this adapter probes BOTH and lets the shared visibility gate
 * decide, rather than hard-coding "the desktop one". Hard-coding would be
 * correct only until the breakpoint moves, at which point the verdict would
 * silently invert — the price would be reported as hidden while plainly on
 * screen. Probing both cannot produce that failure. A hidden duplicate does
 * produce a note on a compliant page, and that note is true, so it is left to
 * stand rather than suppressed.
 *
 * THE TRAPS. Three of them are comma-grouped and non-zero:
 *
 *   • 24h high / low — `273,361` and `260,190` on the stat tiles, and the high
 *     again in the market-information table, where the row is captioned
 *     «بالاترین قیمت در 24 ساعت گذشته» and carries the unit «تتر», not تومان.
 *   • A STALE EDITORIAL PRICE in the FAQ and JSON-LD:
 *         «در زمان نگارش این مطلب، هر تتر برابر با ۱۲۳,۹۹۵ تومان است»
 *     Persian digits, an ASCII comma, and the literal word تومان — exactly the
 *     shape this monitor's pattern accepts, and roughly half the live price.
 *     It is authored content that will never track the market, and no selector
 *     here can reach it.
 *   • The dollar-peg card, «آخرین قیمت تتر به تتر», showing `1`.
 *
 * The change badge is `0<!-- -->%` — a React text-node separator splits the
 * digit from the sign, which defeats a naive `>\d+%` text matcher.
 *
 * «تومان» occurs ~62 times, 7 of them in <head> meta alone, so it is useless
 * as an anchor. Every probe is anchored on the card's own <h3> caption,
 * «آخرین قیمت تتر به تومان», and the neighbouring caption «آخرین قیمت تتر به
 * تتر» cannot collide with it.
 *
 * NOTHING IS RENDERED AS A CHART. There is no <canvas>, no inline SVG with
 * <text> axis labels, and no third-party chart embed; the «نمودار قیمت» card
 * degrades to a dimmed logo placeholder. So there are no axis labels to
 * exclude. The three preloaded `storage.asretether.com/price/usdt/*.webp`
 * files are editorial illustrations, not price screenshots, and their digits
 * are raster rather than DOM text.
 *
 * NOT PROBED, but on the record: the React flight payload carries
 * `price.price_buy` (the displayed figure, unformatted) and, more usefully,
 * `price.price_sell` — a SECOND, DIFFERENT, fully-formed Toman price that is
 * never rendered anywhere, because the market is `is_open:false` and the two
 * sides diverge by roughly 2,500 تومان. Payload disclosure is a note, not a
 * probe, following the کیف پول من / رمزینکس / ایران اکسچنج precedent.
 *
 * UNIT: تومان, printed by the card itself. The feed states it independently:
 * `quote_currency.full_name` is `"IR Toman"` with `decimals: 0`.
 *
 * API: deliberately none, by the operator's standing decision — the fourth such
 * adapter after پول نو, ارزینجا and ایران اکسچنج. Worth recording that this
 * site is the most permissive of the four: its robots.txt has a single
 * `User-agent: *` group with NO named AI-bot blocks and NO `Disallow: /api`, and
 * the operator publishes API documentation openly at apidoc.asretether.com. The
 * feed (`api.asretether.com/v2/market`, anonymous, no headers,
 * `symbol === "USDT-IRT"` → `price.price_buy`) reproduces the displayed price
 * exactly. The screenshot is nonetheless the evidence.
 */

module.exports = {
  id: 'asretether',
  name: 'عصر تتر',
  host: 'asretether.com',
  coin: 'USDT',
  market: 'USDT_IRT',
  unit: 'TMN',
  unitLabel: 'تومان',
  url: 'https://asretether.com/price/usdt',
  currency: 'TMN',

  // See the docblock: the feed exists and matches the page; we choose not to read it.
  api: null,

  probeInPage() {
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
    // Comma-grouping is REQUIRED. That alone rejects the `0<!-- -->%` badge,
    // the `1` of the dollar-peg card and every bare integer in the payload. It
    // does NOT reject the 24h range, the market table, or the stale
    // `۱۲۳,۹۹۵ تومان` in the FAQ — so the SELECTOR is the guard and this
    // pattern is only the second layer.
    const PRICE = /[\d۰-۹٠-٩]{1,3}(?:[,٬][\d۰-۹٠-٩]{3})+(?:\.[\d۰-۹٠-٩]+)?/;

    document.querySelectorAll('[data-probe]').forEach((el) => {
      el.removeAttribute('data-probe');
    });

    // Inline, NOT a module-level constant: this function is serialised into the
    // page, so it cannot reach Node module scope. Referring to one here throws
    // inside the page, and the scraper silently records the page as "not ready".

    /* ---- every card whose caption names the Toman last price ----
     * Anchored on the caption rather than on any class, so a Tailwind rename
     * cannot repoint this at a different element — and the sibling caption
     * «آخرین قیمت تتر به تتر» can never match.
     */
    const found = [];
    const heads = document.querySelectorAll('h3');
    for (let i = 0; i < heads.length; i += 1) {
      if (norm(heads[i].textContent) !== 'آخرین قیمت تتر به تومان') continue;
      // h3 -> the flex row that holds it -> the card.
      const row = heads[i].parentElement;
      const card = row ? row.parentElement : null;
      if (!card) continue;
      // Locate the price slot by SHAPE, not by content: the <p> whose
      // immediately-following sibling is the «تومان» unit span.
      //
      // Matching the PRICE pattern here was a real bug. When this site's feed
      // has no Toman pair it renders the literal text `NaN` — which is not a
      // price, i.e. compliant — but failing to MATCH it produced NO probe at
      // all, so the page reported «نامشخص» instead. The slot exists and says
      // something; the judge must be the one that decides what it means.
      //
      // Scoping to this card also keeps the comma-grouped decoys out: the 24h
      // high `275,338` and low `261,278` sit in DIFFERENT cards
      // («بیشترین/کمترین قیمت (۲۴ ساعت)»), and the stale `۱۲۳,۹۹۵ تومان`
      // lives in the FAQ — outside this card entirely.
      const ps = card.querySelectorAll('p');
      let priceEl = null;
      for (let j = 0; j < ps.length; j += 1) {
        const next = ps[j].nextElementSibling;
        if (next && norm(next.textContent) === 'تومان') { priceEl = ps[j]; break; }
      }
      // No recognisable price line at all — the card did not render one, and
      // reporting an arbitrary <p> would be worse than reporting nothing.
      if (!priceEl) continue;
      found.push({ card, priceEl });
    }

    // One probe per copy. Exactly one of them is on screen at any viewport, so
    // the visibility gate — not the probe order — decides the verdict.
    const probes = [];
    found.forEach((hit, idx) => {
      const key = 'card' + (idx + 1);
      hit.priceEl.dataset.probe = key;
      probes.push({
        key,
        // The desktop copy is the one on screen at the scraper's 1440px
        // viewport, so it is the primary and the one named in the report.
        label: idx === 1 ? 'قیمت تتر به تومان' : 'قیمت تتر به تومان (نسخه موبایل)',
        // Keep the slot's own text when it is not a price. `NaN`, `—` and `—`
        // all classify as "not a published price" (compliant) in diagnose, and
        // showing «NaN» in the evidence row is far more honest than showing a
        // blank. Same fallback پول نو uses for its `۰` slot.
        raw: (norm(hit.priceEl.textContent).match(PRICE) || [])[0] || norm(hit.priceEl.textContent),
        primary: idx === 1,
      });
    });

    return {
      ready: found.length > 0,
      feedLive: found.length > 0,
      probes,
    };
  },
};