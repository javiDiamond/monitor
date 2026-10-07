'use strict';

/**
 * اتراکس (eterex.com) — adapter.
 *
 * Monitored page: https://eterex.com/coin/usdt
 *
 * A single-coin landing page with no comparison table, no other assets and no
 * market ticker — so there is no neighbouring price that could be mistaken for
 * the tether rate. The rate appears in four places, in TWO DIGIT SYSTEMS:
 *
 *   1. hero banner            268,400        Latin digits, ASCII comma
 *   2. #irtAmount input       268,400        Latin digits, ASCII comma
 *   3. «نرخ تبدیل» row        ۲۶۸٬۴۰۰       Persian digits, U+066C
 *   4. «قیمت تومانی» stat     ۲۶۸٬۴۰۰ تومان   Persian digits, U+066C, unit attached
 *
 * Verified live: both formats really are in use at the same time, so the pattern
 * has to accept Persian digits and either separator, and no probe may assume a
 * single house style.
 *
 * THE HERO PRICE IS PAINTED BY A GRADIENT, AND THAT WAS WORTH CHECKING.
 *
 * Every span on the hero price line carries, inline:
 *
 *     color: transparent; -webkit-text-fill-color: transparent;
 *     background-clip: text;
 *
 * with the colour supplied by a gradient. In a captured DOM dump that gradient
 * serialised as an EMPTY `background-image: ;` — and a reader could reasonably
 * conclude the digits paint nothing at all, i.e. that the price is concealed
 * behind transparency. Measured in a real browser, that reading is wrong:
 *
 *     color                   → rgba(0, 0, 0, 0)
 *     -webkit-text-fill-color → rgba(0, 0, 0, 0)
 *     background-image        → linear-gradient(rgb(0,0,0) 0%, rgb(128,128,128) 100%)
 *     background-clip         → text
 *
 * The glyphs paint through the gradient and are plainly readable. So the hero is
 * probed like any other location.
 *
 * Two consequences recorded here rather than left implicit:
 *
 *   • A captured DOM is NOT evidence of paint on this site. Any future check of
 *     this exchange must read resolved computed style in a live browser, never
 *     the serialised inline style.
 *   • `visibility.js` deliberately inspects `display`, `visibility`, `opacity`
 *     and `filter` but NOT `color` / `-webkit-text-fill-color`. That is correct
 *     here (it would otherwise call gradient-painted text invisible), but it
 *     would also report genuinely invisible transparent text as visible. No other
 *     monitored exchange uses this technique, so nothing is changed; it is a
 *     known gap, not a solved problem.
 *
 * THE CLASS COLLISION. The hero's `1` — the USDT quantity — carries a class list
 * BYTE-IDENTICAL to the hero price span's:
 *
 *     text-[24px] text-grayscale-07 leading-[36px] font-[700]
 *
 * so any class-based selector for the price also matches the quantity. Nothing
 * here is found by class; every location is anchored on its own caption, its own
 * id, or a sibling relationship. The collision is pinned by a test.
 *
 * The hero price is located by SHAPE instead — a comma-grouped number whose
 * immediately following sibling is exactly «تومان» — because that pairing occurs
 * once on the page. (The «قیمت تومانی» stat carries its unit inside the same
 * element rather than as a sibling, so the two can never collide.)
 *
 * Nothing else on this page can be mistaken for the price. The other numbers are:
 * `$1.00` (قیمت دلاری, a dot decimal), three `1`s (quantities), `—` (تغییرات ۲۴ ساعته,
 * an em-dash "no data" placeholder), `نامحدود` (supply, deliberately non-numeric),
 * the four gradient step numbers `۱ ۲ ۳ ۴`, and a `0.02%` fee. Only `268,400` and
 * `۲۶۸٬۴۰۰` are comma-grouped anywhere in the document.
 *
 * Confirmed absent, so a future change is noticeable: no price in any `<script>`,
 * none in the RSC flight payload (it carries only chunk bootstrapping), none in
 * any meta tag, and **no JSON-LD block at all**. No price sits inside a collapsed
 * accordion, so there is no hidden-price case here. The chart is a cross-origin
 * `<iframe>` to app.eterex.com. And there is no `filter`, blur, mask, clip-path or
 * opacity anywhere near a price.
 *
 * UNIT: تومان, printed by the page itself. The pair is `USDTIRT` — the trade
 * route is app.eterex.com/advanced-trade/USDTIRT — and the IRT icon sits beside
 * the amount fields.
 *
 * API: none, by the operator's standing decision — the sixth such adapter. Note
 * for the record: the feed was NOT investigated this time (the research run
 * failed), so nothing is claimed about it either way.
 */

module.exports = {
  id: 'eterex',
  name: 'اتراکس',
  host: 'eterex.com',
  coin: 'USDT',
  market: 'USDT_IRT',
  unit: 'IRT',
  unitLabel: 'تومان',
  url: 'https://eterex.com/coin/usdt',
  currency: 'IRT',

  // The operator's standing decision: اتراکس has DISABLED its tether page
  // outright. A 5xx from this URL is the finding itself — the page is switched
  // off and shows no price — so the check records compliance and the fallback
  // market page never produces the verdict. A 404 (or anything else) still
  // counts as an unreadable page and stays «نامشخص».
  http5xxMeansDisabled: true,

  api: null,

  fallback: {
    url: 'https://app.eterex.com/market',
    label: 'بازار معاملاتی اتراکس',

    /**
     * The backup page is a client-rendered SPA: its served HTML is an empty
     * `#app` shell, so nothing here exists until JavaScript has run. The scraper
     * drives a real browser, which is why this works at all.
     *
     * Each market row is a `role="button"` grid of five direct <span>s:
     * coin identity, `$` price, IRT price, `0%` change, and a button cluster.
     * The IRT cell is the only one that is purely numeric, so `$1` and `0%` are
     * excluded by shape rather than by position — a reorder of the grid must
     * not silently repoint this at the dollar column.
     */
    probeInPage({ coin }) {
      const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
      document.querySelectorAll('[data-probe]').forEach((el) => {
        el.removeAttribute('data-probe');
      });

      const wanted = (coin || 'USDT').toUpperCase();
      const img = document.querySelector('img[alt="' + wanted + '"]');
      const row = img ? img.closest('[role="button"]') : null;
      if (!row) {
        return { ready: false, feedLive: false, probes: [] };
      }

      const cells = Array.from(row.children).filter((el) => el.tagName === 'SPAN');
      const irtCell = cells.find((el) => {
        const t = norm(el.textContent);
        return t && t.indexOf('$') === -1 && t.indexOf('%') === -1 && /^[\d.,٬۰-۹٠-٩]+$/.test(t);
      });
      if (!irtCell) {
        return { ready: false, feedLive: false, probes: [] };
      }

      const value = norm(irtCell.textContent);
      irtCell.dataset.probe = 'market';

      return {
        ready: true,
        feedLive: true,
        probes: [
          {
            key: 'market',
            label: 'قیمت تتر در بازار معاملاتی',
            // Verbatim: `0` is the finding, and if the market opens this same
            // cell fills with a real rate and becomes a violation. A matching
            // comma-grouped number is not forced — classifyValue judges it.
            raw: value,
            primary: true,
          },
        ],
      };
    },

    /**
     * THE TRUST GATE.
     *
     * This page can render a row of zeros simply because its own price feed is
     * down — `api.eterex.com` answers 404 on every path — and a grid of zeros
     * would then read as «the price is not published», i.e. COMPLIANT, when the
     * truth is «we could not tell». So a zero is only believed when the grid
     * proves it is alive: more than one row, and at least one row carrying a
     * real comma-grouped تومان figure.
     *
     * Live feed  → USDT's 0 is a genuine reading → compliant
     * Dead feed  → every row is 0             → keep «نامشخص»
     */
    feedLooksAlive() {
      const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const rows = Array.from(document.querySelectorAll('[role="button"]'));
      if (rows.length < 2) return false;
      return rows.some((r) =>
        Array.from(r.children)
          .filter((el) => el.tagName === 'SPAN')
          .some((el) => /^[\d۰-۹٠-٩]{1,3}[,٬][\d۰-۹٠-٩]{3}/.test(norm(el.textContent)))
      );
    },
  },

  probeInPage() {
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
    // Comma-grouping is REQUIRED. That alone rejects `$1.00`, the three `1`
    // quantities, the four Persian step numbers and the `0.02%` fee. The hero
    // `1` is the only real hazard and it has no comma either — so the SELECTOR
    // is the guard here, and this pattern is the second layer.
    const PRICE = /[\d۰-۹٠-٩]{1,3}(?:[,٬][\d۰-۹٠-٩]{3})+(?:\.[\d۰-۹٠-٩]+)?/;
    const matchOf = (el) => (el ? (norm(el.textContent).match(PRICE) || [])[0] || null : null);
    // A slot that exists but does not hold a price still carries meaning:
    // `NaN`, `—` and `0` all read as "not published" and are compliant, and
    // showing the real text in the evidence row beats a blank. Same fallback
    // پول نو and asretether use.
    const slotText = (el) => (el ? matchOf(el) || norm(el.textContent) : null);

    document.querySelectorAll('[data-probe]').forEach((el) => {
      el.removeAttribute('data-probe');
    });

    // Inline, NOT a module-level constant: this function is serialised into the
    // page, so it cannot reach Node module scope. Referring to one here throws
    // inside the page, and the scraper silently records the page as "not ready".

    /* ---- 1. the hero banner ----
     * Located by shape: a comma-grouped number whose IMMEDIATELY FOLLOWING
     * sibling is exactly «تومان». The quantity beside it — `1` — carries a
     * byte-identical class list but has no such sibling, and the «قیمت تومانی»
     * stat keeps its unit inside one element rather than as a sibling. So this
     * pairing occurs exactly once.
     */
    let heroEl = null;
    const allSpans = document.querySelectorAll('span');
    for (let i = 0; i < allSpans.length; i += 1) {
      const s = allSpans[i];
      if (!PRICE.test(norm(s.textContent))) continue;
      const next = s.nextElementSibling;
      if (next && norm(next.textContent) === 'تومان') { heroEl = s; break; }
    }
    if (heroEl) heroEl.dataset.probe = 'hero';

    /* ---- 2. the trading input ----
     * Pre-filled with the live rate, so the price is on screen — but it lives in
     * the `value` PROPERTY, not in text content, and an <input>'s innerText is
     * always empty. So it is probed and never photographed: a screenshot of it
     * could never satisfy the verifier's "the image contains the value" check.
     */
    const input = document.querySelector('#irtAmount');
    const inputRaw = input ? (String(input.value || '').match(PRICE) || [])[0] || null : null;
    if (input) input.dataset.probe = 'input';

    /* ---- 3. the «نرخ تبدیل» row ----
     * Caption-anchored, so a Tailwind rename cannot repoint it. Only one span in
     * that row is comma-grouped — the `USDT`, `1`, `=` and `IRT` cells are not.
     */
    const rateLabel = [];
    for (let i = 0; i < allSpans.length; i += 1) {
      if (norm(allSpans[i].textContent) === 'نرخ تبدیل') { rateLabel.push(allSpans[i]); break; }
    }
    let rateEl = null;
    if (rateLabel.length) {
      const row = rateLabel[0].parentElement;
      if (row) {
        const inner = row.querySelectorAll('span');
        for (let i = 0; i < inner.length; i += 1) {
          if (PRICE.test(norm(inner[i].textContent))) { rateEl = inner[i]; break; }
        }
      }
    }
    if (rateEl) rateEl.dataset.probe = 'rate';

    /* ---- 4. the «قیمت تومانی» stat ----
     * The value is the label's next sibling, and it carries its own unit.
     */
    let statLabel = null;
    for (let i = 0; i < allSpans.length; i += 1) {
      if (norm(allSpans[i].textContent) === 'قیمت تومانی') { statLabel = allSpans[i]; break; }
    }
    const statEl = statLabel ? statLabel.nextElementSibling : null;
    if (statEl) statEl.dataset.probe = 'stat';

    const found = !!(heroEl || input || rateEl || statEl);

    return {
      ready: found,
      feedLive: found,
      probes: [
        { key: 'hero', label: 'قیمت تتر در بنر اصلی', raw: matchOf(heroEl), primary: true },
        { key: 'input', label: 'مبلغ پیش‌فرض خرید', raw: inputRaw },
        { key: 'rate', label: 'نرخ تبدیل', raw: matchOf(rateEl) },
        { key: 'stat', label: 'قیمت تومانی', raw: slotText(statEl) },
      ],
    };
  },
};