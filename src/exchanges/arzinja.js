'use strict';

/**
 * ارزینجا (arzinja.info) — adapter.
 *
 * Monitored page: https://arzinja.info/tether
 *
 * ارزینجا publishes the tether rate in FIVE places on this one page and
 * conceals nothing: the document contains zero `opacity-0`, zero `filter`, zero
 * `backdrop-filter`, zero `display:none`, zero blur and zero masks. Every price
 * is server-rendered plain text.
 *
 *   1. the #price hero block          «قیمت تتر امروز:»   → "… تومان"
 *   2. the «قیمت لحظه ای تتر» stat card                 → "… تومان"
 *   3. the instant-trade ticker       «۱ USDT = … IRT»
 *   4. the sidebar row «آخرین قیمت تتر به تومان»        → bare number
 *   5. the market table «بازارهای معاملاتی تتر»         → IRT/USDT price cell
 *
 * TWO TECHNIQUES THAT WORKED ON OTHER SITES ARE WORTHLESS HERE, and both traps
 * they would fall into are on this page:
 *
 *   • The word «تومان» is NOT a unique anchor. It occurs ~46 times in the
 *     rendered markup — in the <title>, the meta keywords, five prose
 *     paragraphs, an <input placeholder>, two <img alt> attributes, a pair
 *     sub-label, and one stale editorial figure. On همتاپی that word identified
 *     exactly one element; here it identifies dozens.
 *
 *   • `.tabular-nums` matches exactly TWO elements and the FIRST one in
 *     document order is the dollar peg:
 *         <span class="… tabular-nums">(۱دلار)</span>
 *         <span class="font-bold text-xl … tabular-nums">۲۶۷,۸۴۰ تومان</span>
 *     So `querySelector('.tabular-nums')` on this page returns the $1 peg. The
 *     price requires `.font-bold` as well.
 *
 * THE TWO NEAREST DECOYS ARE THE SERIOUS ONES. Under «رمزارز های مشابه» the
 * sidebar lists two stablecoins that are pegged to the very same asset:
 *
 *     TUSD   ۲۶۷,۷۸۶ IRT      ← 113 تومان from the real price
 *     USDC   ۲۶۷,۸۹۳ IRT      ←  53 تومان away
 *
 * Same six digits, same comma, same IRT unit label, same page. Neither may be
 * read as the tether rate. The 24h high (`۲۶۹,۵۸۵`) and low (`۲۶۲,۶۰۵`) have
 * the identical shape, and the stat grid carries three more comma-grouped
 * non-zero figures (24h volume, market cap, circulating supply).
 *
 * A trap that lives in prose: the only U+066C separator in the entire document
 * belongs to a STALE editorial figure, «حدود ۹۰٬۷۸۸ تومان», inside a body
 * paragraph. All live prices use an ASCII comma. The pattern accepts both
 * separators, so the SELECTORS — never a text sweep — are what keep that
 * paragraph out of the verdict.
 *
 * NOT USED, and deliberately so:
 *   • The chart is a TradingView <iframe>. Nothing readable inside, and charts
 *     are excluded by policy regardless (tabdeal, arzplus, sarmayex, hamtapay).
 *   • The «بازار ارزینجا / بازار جهانی» toggle holds no sibling price node and
 *     is never clicked.
 *   • `__NEXT_DATA__` is actively misleading: it carries `"page":"/"` with
 *     `gssp:true`, so it is the HOMEPAGE payload, and its
 *     `USDTIRT.stats.lastPrice` is a stale `267990` that does not match the
 *     `۲۶۸,۵۰۵` on screen. Nothing here reads it.
 *
 * UNIT: تومان, stated by the page itself («قیمت تتر به تومان» is the sidebar
 * row's own caption) and by the trading pair `USDTIRT`. The ticker's «IRT»
 * label means تومان here, as it does at tabdeal.
 *
 * API: deliberately none, per the operator's decision. A public unauthenticated
 * feed does exist — `api-v2.arzinja.app/api/v1/currencies/USDT`, whose
 * `result.last_irt_price` matches the page — but ارزینجا's robots.txt carries
 * `Disallow: /api` and names AI crawlers among the disallowed agents. Not using
 * it is a recorded decision, not an oversight; it is the second such adapter
 * after پول نو. That also means the screenshot is the entire evidence.
 */

module.exports = {
  id: 'arzinja',
  name: 'ارزینجا',
  host: 'arzinja.info',
  coin: 'USDT',
  market: 'USDTIRT',
  unit: 'IRT',
  unitLabel: 'تومان',
  url: 'https://arzinja.info/tether',
  currency: 'IRT',

  // See the docblock: a public feed exists, but robots.txt disallows /api.
  api: null,

  probeInPage() {
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
    // Comma-grouping is REQUIRED. That alone rejects every percentage
    // (`٪۲.۰۶`, `۶.۴۱۲۶%`), the `(۱دلار)` and `$۱` pegs, the rank `۳`, and
    // `۰.۹۹۹۶ دلار`. It does NOT reject the TUSD/USDC rows, the 24h range, the
    // volumes, or the stale `۹۰٬۷۸۸` prose — so the SELECTOR is the guard and
    // this pattern is only the second layer.
    const PRICE = /[\d۰-۹٠-٩]{1,3}(?:[,٬][\d۰-۹٠-٩]{3})+(?:\.[\d۰-۹٠-٩]+)?/;

    document.querySelectorAll('[data-probe]').forEach((el) => {
      el.removeAttribute('data-probe');
    });

    // Inline, NOT a module-level constant: this function is serialised into the
    // page, so it cannot reach Node module scope. Referring to one here throws
    // inside the page, and the scraper silently records the page as "not ready".

    const matchOf = (el) => (el ? (norm(el.textContent).match(PRICE) || [])[0] || null : null);

    /* ---- 1. the #price hero block (primary) ----
     * `.font-bold` is REQUIRED. The bare `.tabular-nums` selector returns the
     * `(۱دلار)` peg, because that element comes first in document order.
     */
    const heroEl = document.querySelector('#price span.font-bold.tabular-nums');
    if (heroEl) heroEl.dataset.probe = 'hero';

    /* ---- caption-driven helpers ----
     * Anchored on the visible caption rather than on a class, so a Tailwind
     * rename cannot silently point these at another element.
     */
    const h3ByText = (text) => {
      const all = document.querySelectorAll('h3');
      for (let i = 0; i < all.length; i += 1) {
        if (norm(all[i].textContent) === text) return all[i];
      }
      return null;
    };

    /* ---- 2. the «قیمت لحظه ای تتر» stat card ---- */
    const cardH3 = h3ByText('قیمت لحظه ای تتر');
    const cardEl = cardH3 ? cardH3.parentElement.querySelector('p') : null;
    if (cardEl) cardEl.dataset.probe = 'card';

    /* ---- 3. the instant-trade ticker «۱ USDT = … IRT» ----
     * Anchored at BOTH ends, so the match is the ticker itself and not some
     * larger container that merely happens to contain an `=` and an `IRT`.
     */
    const TICKER = /^[\d۰-۹٠-٩. ,٬]*USDT\s*=\s*[\d۰-۹٠-٩][\d۰-۹٠-٩,٬.]*\s*IRT$/;
    let tickEl = null;
    const spans = document.querySelectorAll('span');
    for (let i = 0; i < spans.length; i += 1) {
      if (TICKER.test(norm(spans[i].textContent))) { tickEl = spans[i]; break; }
    }
    if (tickEl) tickEl.dataset.probe = 'ticker';

    /* ---- 4. the sidebar row «آخرین قیمت تتر به تومان» ----
     * Its value carries NO unit suffix, just the bare number.
     */
    const rowH3 = h3ByText('آخرین قیمت تتر به تومان');
    const rowEl = rowH3 ? rowH3.nextElementSibling : null;
    if (rowEl) rowEl.dataset.probe = 'sidebar';

    /* ---- 5. the market-table USDT/IRT price cell ----
     * `.text-spec-currency-price` matches TWO cells in that row — the price and
     * the 24h volume — so it cannot be queried directly. The IRT symbol cell is
     * unique, and the price is its immediate next sibling.
     */
    const syms = document.querySelectorAll('.text-spec-currency-symbol');
    let sym = null;
    for (let i = 0; i < syms.length; i += 1) {
      if (norm(syms[i].textContent) === 'IRT') { sym = syms[i]; break; }
    }
    const tableEl = sym ? sym.nextElementSibling : null;
    if (tableEl) tableEl.dataset.probe = 'marketTable';

    const found = !!(heroEl || cardEl || tickEl || rowEl || tableEl);

    return {
      ready: found,
      // Unlike the compliant exchanges, this page carries a live feed; it is
      // simply that we do not read it, per the operator's decision above.
      feedLive: found,
      probes: [
        { key: 'hero', label: 'قیمت تتر امروز', raw: matchOf(heroEl), primary: true },
        { key: 'card', label: 'قیمت لحظه ای تتر', raw: matchOf(cardEl) },
        { key: 'ticker', label: 'نرخ تبدیل در معامله آنی', raw: matchOf(tickEl) },
        { key: 'sidebar', label: 'آخرین قیمت تتر به تومان', raw: matchOf(rowEl) },
        { key: 'marketTable', label: 'قیمت تتر در جدول بازار', raw: matchOf(tableEl) },
      ],
    };
  },
};