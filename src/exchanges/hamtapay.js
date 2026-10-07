'use strict';

/**
 * همتاپی (hamtapay.net) — adapter.
 *
 * Monitored page: https://hamtapay.net/markets/USDT
 *
 * همتاپی publishes the tether rate in two places and conceals nothing: no blur,
 * no opacity, no display:none, and the price's own `overflow-hidden` ancestor
 * does not clip it at desktop width. Both copies are server-rendered — the
 * `<!---->` markers around them are Vue branch anchors, not hydration
 * placeholders, and the number is literal text in the initial HTML.
 *
 *   1. the page header, next to the caption «تومان»   (primary)
 *   2. the «ارزهای دیگر» strip, which mirrors the same number
 *
 * THE HEADER IS ANCHORED ON THE WORD «تومان», NOT ON A CLASS.
 *
 * That is deliberate and it is the most robust selector available here: the
 * string تومان occurs EXACTLY ONCE in the whole document (there is no «ریال»
 * anywhere), and the price is its immediately preceding sibling. A class-based
 * selector would have to pick one out of a minefield — `.tabular-nums`, the
 * obvious candidate, matches FIFTEEN elements on this page.
 *
 * What those fifteen are, and why none of them may be read:
 *
 *   84,878.01  2,682.17  0.09284  774.27  1.20
 *       → BTC/ETH/DOGE/BNB/DOT in the header dropdown, LATIN digits,
 *         comma-grouped and non-zero. They sit inside panels carrying an
 *         inline `style="display:none;"`, so a zero-size rect keeps them
 *         out of the verdict — but a text sweep would happily read `84,878.01`
 *         as a price. These are the most dangerous strings on the page.
 *   ۱ USDT
 *       → «قیمت تتر به تتر», the dollar peg. Non-zero, and it shares
 *         `.tabular-nums` with the real price, so only its lack of comma
 *         grouping saves it.
 *   ۱۸۳,۸۷۰,۶۸۳,۹۹۸.۹۲
 *       → ارزش کل بازار, the market cap. Comma-grouped WITH decimals and in
 *         the exact same digit style as the price. The regex cannot reject
 *         this one; only the selector can.
 *   ۲۲,۸۳۱,۱۵۰,۴۲۵  ۷۲۱,۶۷۲,۶۳۱  ۲۰۸,۳۱۲,۴۵۶
 *       → BTC / ETH / BNB market caps in the same strip as the mirror.
 *   ۲۶۹K  ۲۶۸K  ۲۶۶K  ۲۶۵K  ۲۶۳K  ۲۶۲K
 *       → chart Y-axis ticks inside the inline SVG. Excluded by policy
 *         (see below); they carry no separator, so the regex rejects them
 *         anyway.
 *   —   and three empty <input>s
 *
 * The 24h-high cell («بیشترین قیمت») renders `$۱` on the live site — a data
 * bug on their side, not concealment, and not a تومان price.
 *
 * EXCLUDED: the 1D/1W/1Y/1H chart. Its axis ticks are not current prices, and
 * the plotted path is a curve rather than a readable figure — the same rule as
 * tabdeal and arzplus. We never click the period switcher either; it holds
 * only four labels and a decorative sliding pill.
 *
 * THE STRIP RENDERS LATE. It is absent from the early DOM and appears after
 * hydration (15 `.tabular-nums` elements, not 11). A probe that reported
 * "not ready" until the strip showed up would mark this exchange as نامشخص
 * on every fast sample, so the strip is probed opportunistically: when it is
 * missing it simply yields null and the header decides.
 *
 * UNIT: تومان, stated by the feed rather than inferred — the market is
 * `USDT-IRT` and `quote_name` is literally `"Toman"`. No Rial pair exists
 * among the 607 symbols the API serves.
 *
 * DIGITS are Persian with a LATIN comma (`۲۶۸,۹۱۳`) in both locations. The
 * hidden dropdown prices above use Latin digits, so neither script can be
 * assumed; the pattern accepts both.
 *
 * NO PAYLOAD LEAK. Unlike every other Nuxt exchange monitored here, همتاپی's
 * `__NUXT_DATA__` carries no price at all: all three stores are `NuxtError`
 * objects with `statusCode:404` and `prices.byMarket` is an empty object. The
 * price exists only in the SSR HTML. Worth recording explicitly, because the
 * absence of a payload leak is NOT evidence of compliance — this page shows
 * the price in plain sight and leaks nothing in the payload.
 *
 * API: `/api/bus/client/prices` is same-origin, public, and needs no headers
 * at all — verified with `User-Agent` and `Accept` explicitly cleared. Read
 * `market_price` only: the same object carries `sell` and `buy` as 27-digit
 * decimal strings and an `avg` of 269338.75… that is close to, but not, the
 * market price. Three plausible numbers, one of which is the right one.
 */

module.exports = {
  id: 'hamtapay',
  name: 'همتاپی',
  host: 'hamtapay.net',
  coin: 'USDT',
  market: 'USDT_IRT',
  unit: 'IRT',
  unitLabel: 'تومان',
  url: 'https://hamtapay.net/markets/USDT',
  currency: 'IRT',

  api: {
    // A bare GET on the site's own origin. No auth, no signature, no key.
    url: 'https://hamtapay.net/api/bus/client/prices',
    parse(text) {
      const json = JSON.parse(text);
      // A flat map keyed by pair, ~607 symbols. Filter on the exact `USDT-IRT`
      // key: the map also holds every other coin, and also `*-USDT` pairs
      // quoted in dollars, so "the USDT one" is not a safe selector.
      const pair = (json.data && json.data['USDT-IRT']) || null;
      if (!pair) return null;
      // `market_price` is the integer the site's own UI renders. Not `sell` or
      // `buy` (order-book bounds, 27-digit decimals) and not `avg` (a rolling
      // average that sits close to but deliberately differs from the price).
      const price = Number(pair.market_price);
      const change = Number(pair.change_rate_24h);
      return {
        price: Number.isFinite(price) ? price : null,
        change: Number.isFinite(change) ? change : null,
        // Quoted in تومان — quote_name says "Toman".
        unitScale: 1,
      };
    },
  },

  probeInPage() {
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
    // Comma-grouping is REQUIRED. That alone rejects the `۱ USDT` peg, the
    // `$۱` 24h-high cell, the `۲۶۹K` chart ticks and the Fear & Greed `۶۷`.
    // It does NOT reject the market caps (`۱۸۳,۸۷۰,۶۸۳,۹۹۸.۹۲`) or the
    // dropdown prices — so the SELECTOR is the guard and this is layer two.
    //
    // Persian digits + a Latin comma is what both live locations use; the
    // hidden dropdown uses Latin digits, so both are accepted.
    const PRICE = /[\d۰-۹٠-٩]{1,3}(?:[,٬][\d۰-۹٠-٩]{3})+(?:\.[\d۰-۹٠-٩]+)?/;

    document.querySelectorAll('[data-probe]').forEach((el) => {
      el.removeAttribute('data-probe');
    });

    // Inline, NOT a module-level constant: this function is serialised into the
    // page, so it cannot reach Node module scope. Referring to one here throws
    // inside the page, and the scraper silently records the page as "not ready".

    /* ---- 1. the page header (primary) ----
     * Anchored on the unit word, which occurs exactly once in the document,
     * rather than on `.tabular-nums`, which occurs fifteen times. The price is
     * the unit's immediately preceding sibling.
     */
    let unitEl = null;
    const spans = document.querySelectorAll('span');
    for (let i = 0; i < spans.length; i += 1) {
      if (norm(spans[i].textContent) === 'تومان') { unitEl = spans[i]; break; }
    }
    const headWrap = unitEl ? unitEl.previousElementSibling : null;
    const headEl = headWrap ? headWrap.querySelector('.tabular-nums') : null;
    const headRaw = headEl ? (norm(headEl.textContent).match(PRICE) || [])[0] || null : null;

    // Probe the number itself. The evidence image is the whole page, which
    // already shows the «تومان» unit and the change badge around it.
    if (headEl) headEl.dataset.probe = 'header';

    /* ---- 2. the «ارزهای دیگر» strip ----
     * The exact href matters: eight social-share links also point at
     * /markets/USDT, and the active-row classes confirm this is the mirrored
     * coin row and not a share button. Renders late, so null is a valid answer.
     */
    const stripRow = document.querySelector('a[href="/markets/USDT"].router-link-exact-active');
    const stripEl = stripRow ? stripRow.querySelector('.tabular-nums') : null;
    const stripRaw = stripEl ? (norm(stripEl.textContent).match(PRICE) || [])[0] || null : null;

    if (stripEl) stripEl.dataset.probe = 'strip';

    const found = !!(headEl || stripEl);

    return {
      // Either location is enough to render the page. The strip is allowed to
      // be absent without that making the exchange نامشخص.
      ready: found,
      // The opposite of the compliant exchanges: this page carries a real live
      // feed, and websocket pricing on top of the REST endpoint we read.
      feedLive: found,
      probes: [
        { key: 'header', label: 'قیمت تتر در بالای صفحه', raw: headRaw, primary: true },
        { key: 'strip', label: 'قیمت تتر در فهرست ارزهای دیگر', raw: stripRaw },
      ],
    };
  },
};