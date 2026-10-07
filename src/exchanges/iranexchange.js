'use strict';

/**
 * ایران اکسچنج (iranexchange.com) — adapter.
 *
 * Monitored page: https://iranexchange.com/buy-usdt
 *
 * Unlike its neighbours, ایران اکسچنج is a marketplace site rather than an
 * exchange dashboard: a marketing landing page for buying tether. It publishes
 * the rate plainly and conceals nothing — zero backdrop-filter, zero
 * visibility:hidden, zero clip-path, zero mask, and no blur or opacity anywhere
 * on or above a price. The page is fully server-rendered, so there is no
 * hydration race.
 *
 * ONE PRICE, AND IT MOVES BETWEEN SURFACES.
 *
 *   • The conversion widget at the top reads «۱ تتر = ۲۶۸٬۱۰۰ تومان» —
 *     Persian digits with U+066C, the only U+066C live price on the page.
 *   • The market table quotes 268,800 in LATIN digits with an ASCII comma,
 *     where it lists tether at all.
 *
 * So the two surfaces use different digit scripts AND different separators, and
 * on the live site they do not even agree on the number (the widget tracks
 * `sellToIranicardCurrencyPrice`, the table a separately-derived figure). The
 * pattern therefore has to accept both formats, and no probe may assume the
 * locations agree.
 *
 * THE MARKET TABLE USUALLY DOES NOT LIST TETHER AT ALL. Verified on the live
 * site: the default table renders 24 coins and tether is not among them (the
 * list is tabbed — جدیدترین‌ها / پرسودترین‌ها / ضررده‌ترین‌ها — and paginated,
 * so the contents move). A captured DOM from an earlier load did contain a USDT
 * row, which is why that row is still probed — but opportunistically, and its
 * absence must never turn a clearly-showing page into «نامشخص».
 *
 * When the row IS present it is genuinely awkward: the price is rendered in
 * THREE cells. Two desktop columns (قیمت خرید / قیمت فروش) carry byte-identical
 * class lists and differ only by position, and a third copy sits in a mobile-only
 * cell with `sm:hidden` that is display:none at our viewport. The two desktop
 * cells wrap their price in `<a aria-label="USDT">` and the mobile cell does
 * not, which is the only reliable discriminator.
 *
 * The word «تومان» is useless as an anchor here: it occurs over a hundred times,
 * 72 of them as bare `<span>تومان</span>` labels inside the table itself.
 * Everything below is anchored on its own container instead.
 *
 * NOT RENDERED, SO NOT PROBED — recorded rather than ignored:
 *   • A schema.org `Product` block carries `"price":2680500,
 *     "priceCurrency":"IRR"` — 268,050 تومan, correct to the unit, but in a
 *     `<script>`, so no visitor sees it.
 *   • The React flight payload embeds `sellToIranicardCurrencyPrice`.
 *   Following the kifpool / ramzinex precedent, payload disclosure is a note.
 *
 * Worth knowing and NOT treated as a tether price: the table quotes **USDC** in
 * the same تومان band (≈268,689). It is a 1:1 dollar peg, so it reveals the
 * tether rate by the same arithmetic every site's public asset prices do. The
 * monitor is per-asset USDT, so it is not read — but it is the clearest
 * illustration of the question this tool cannot decide for you.
 *
 * UNIT: تومان, printed by the widget itself. The JSON-LD corroborates the
 * scale in the other direction: `IRR` 2,680,500 is the same order of magnitude
 * ten times up, exactly as at ramzinex.
 *
 * API: deliberately none, by the operator's decision — the third such adapter
 * after پول نو and ارزینجا. A public anonymous feed does exist
 * (`api.iranexchange.com/api/public/modules/crypto/v1/client/listProduct`,
 * no headers, rate-limited), and its USDT value × 0.1 reproduces the widget
 * exactly; its robots.txt lives on a different host and does not disallow it.
 * The decision was to not use it anyway, and the screenshot is the evidence.
 */

module.exports = {
  id: 'iranexchange',
  name: 'ایران اکسچنج',
  host: 'iranexchange.com',
  coin: 'USDT',
  market: 'USDT_IRT',
  unit: 'TMN',
  unitLabel: 'تومان',
  url: 'https://iranexchange.com/buy-usdt',
  currency: 'TMN',

  // See the docblock: the feed exists, and we choose not to read it.
  api: null,

  probeInPage() {
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
    // Comma-grouping is REQUIRED, and BOTH separators are accepted because
    // this page uses U+066C in the widget and an ASCII comma in the table.
    // That alone rejects the `0.00%` change, the widget's `1` quantity and
    // every bare integer in the flight payload. It does NOT reject the other
    // coins' prices or the card strip — so the SELECTOR is the guard and this
    // pattern is only the second layer.
    const PRICE = /[\d۰-۹٠-٩]{1,3}(?:[,٬][\d۰-۹٠-٩]{3})+(?:\.[\d۰-۹٠-٩]+)?/;
    const matchOf = (el) => (el ? (norm(el.textContent).match(PRICE) || [])[0] || null : null);

    document.querySelectorAll('[data-probe]').forEach((el) => {
      el.removeAttribute('data-probe');
    });

    // Inline, NOT a module-level constant: this function is serialised into the
    // page, so it cannot reach Node module scope. Referring to one here throws
    // inside the page, and the scraper silently records the page as "not ready".

    /* ---- 1. the conversion widget (primary) ----
     * Self-locating: a price <p> whose immediately following sibling is exactly
     * «تومان», sitting in a row that also names «تتر». No class names, so a
     * Tailwind rename cannot repoint it — and «تومان» alone would be hopeless,
     * since it occurs over a hundred times on this page.
     */
    let widgetEl = null;
    const ps = document.querySelectorAll('p.truncate');
    for (let i = 0; i < ps.length; i += 1) {
      const next = ps[i].nextElementSibling;
      if (!next || norm(next.textContent) !== 'تومان') continue;
      if (!PRICE.test(norm(ps[i].textContent))) continue;
      const holder = ps[i].parentElement ? ps[i].parentElement.parentElement : null;
      if (holder && norm(holder.textContent).indexOf('تتر') !== -1) { widgetEl = ps[i]; break; }
    }
    if (widgetEl) widgetEl.dataset.probe = 'widget';

    /* ---- 2. the market table's tether row (opportunistic) ----
     * Absent on most loads, so a null here is normal and must never make the
     * page "not ready". When present: identity from the aria-label, then the
     * buy-price cell by position.
     */
    const link = document.querySelector('a[aria-label="USDT"][href="/market/USDT"]');
    const row = link ? link.closest('tr') : null;
    // children[1] is قیمت خرید and children[2] is قیمت فروش. The third copy of
    // the price lives in children[4], a mobile-only `sm:hidden` cell, and is
    // deliberately never probed.
    const buyCell = row ? row.children[1] : null;
    let tableEl = null;
    if (buyCell) {
      const spans = buyCell.querySelectorAll('span');
      for (let i = 0; i < spans.length; i += 1) {
        if (PRICE.test(norm(spans[i].textContent))) { tableEl = spans[i]; break; }
      }
    }
    if (tableEl) tableEl.dataset.probe = 'table';

    const found = !!(widgetEl || tableEl);

    return {
      // The widget alone is enough to render the page and to disclose the rate.
      ready: found,
      feedLive: found,
      probes: [
        { key: 'widget', label: 'نرخ تبدیل تتر در صفحه خرید', raw: matchOf(widgetEl), primary: true },
        { key: 'table', label: 'قیمت خرید تتر در جدول بازار', raw: matchOf(tableEl) },
      ],
    };
  },
};