'use strict';

/**
 * سرمایکس (sarmayex.com) — adapter.
 *
 * Monitored page: https://sarmayex.com/
 *
 * سرمایکس publishes the tether rate in THREE separate live places on its
 * homepage, all agreeing on one number, and hides nothing: no blur, no
 * opacity, no display:none, no clipping. The server renders all three, so there
 * is no hydration race to wait out either.
 *
 *   1. market table row   (the canonical one — the row the regulator would read)
 *   2. ticker tape        (a scrolling marquee under the header)
 *   3. hero card          (the "شکار سود" marketing grid)
 *
 * THE PAGE IS A MINEDFIELD, AND ONE TRAP IS NASTIER THAN THE REST:
 *
 *   • The 24h VOLUME column sits in the SAME ROW as the price and is
 *     comma-grouped with two decimals — `45,981.12`, non-zero. A text scrape of
 *     the row reads it immediately. The live page renders it as `۴۶٬۱۴۴.51`,
 *     i.e. Persian digits in the integer part but LATIN digits in the decimal —
 *     a mixed-formatted number that parses perfectly well into 46144.51.
 *   • The 24h CHANGE is duplicated, and one of the two copies lives INSIDE the
 *     very `<td>` that holds the price, split across `<span>+</span>` and
 *     `<span>2.383% </span>`. The desktop copy is in a different `<td>` and
 *     drops the `+`. It is safe only because a percentage has no comma grouping.
 *   • The coin "تتر گلد" (Tether-Gold, XAUT) has the word تتر INSIDE ITS OWN
 *     NAME. Any `text=تتر` / `contains('تتر')` matcher reads Tether-Gold
 *     (1,110,238,208) instead of tether. This is why nothing here matches on
 *     the coin's name at all.
 *   • The table header carries a تومان/تتر unit toggle button, so even a
 *     caption-based matcher collides.
 *
 * The fix for all of the above is the same: anchor on the PAIR, never on the
 * name or the caption. The trade link is `/trade/USDT_IRT`, and the suffix is
 * matched exactly — a bare `href*=USDT` matches all 22 USDT links on the page
 * (every `*_USDT` market in the ticker), while `href$="/trade/USDT_IRT"` is
 * 3: one per display site.
 *
 * UNIT: تومان. Not inferred from the magnitude — the feed states it outright:
 * `"quote_name":"IR Toman"`, `"quote_locale_name":"تومان"`,
 * `"locale_name":"تتر / تومان"`. The pair is `USDT_IRT`, and `IRT` here means
 * Toman exactly as it does at tabdeal.
 *
 * DIGITS DIFFER BY LOCATION, which is why the regex accepts both scripts and
 * both separators: the ticker prints `267,433` in Latin digits with a comma,
 * while the table row and the hero card print `۲۶۷٬۴۳۳` in Persian digits with
 * U+066C. The `data-number="fa"` attribute on <html> only swaps the numeral
 * FONT, but the page clearly does rewrite digits too, so neither format can be
 * assumed.
 *
 * API: `core.sarmayex.com/api/v1/pairs` is public and needs no headers at all
 * (not even a User-Agent), and it is what feeds this page — its ticker_high and
 * ticker_low match the homepage's «بالاترین»/«پایین ترین» exactly. Read `price`
 * only: the same object also carries `ticker_high`, `ticker_low`,
 * `ticker_volume`, and a Toman-denominated `ticker_quote_volume` large enough
 * (12,173,400,064) to look like a Rial price.
 */

module.exports = {
  id: 'sarmayex',
  name: 'سرمایکس',
  host: 'sarmayex.com',
  coin: 'USDT',
  market: 'USDT_IRT',
  unit: 'IRT',
  unitLabel: 'تومان',
  url: 'https://sarmayex.com/',
  currency: 'IRT',

  api: {
    // A bare GET. Anonymous, no auth, no headers. (HEAD returns 404 — Laravel
    // declares no HEAD route — so this must stay a GET.)
    url: 'https://core.sarmayex.com/api/v1/pairs',
    parse(text) {
      const json = JSON.parse(text);
      // A flat map keyed by pair, 31 entries. Filter on the exact `USDT_IRT`
      // key: the map also holds `BTC_IRT`, `ADA_IRT` and every `*_USDT` market,
      // so "the USDT one" is not a safe selector.
      const pair = (json.data && json.data.USDT_IRT) || null;
      if (!pair) return null;
      const price = Number(pair.price);
      const change = Number(pair.change_percent);
      return {
        price: Number.isFinite(price) ? price : null,
        change: Number.isFinite(change) ? change : null,
        // Quoted in تومان — stated by quote_locale_name, not guessed.
        unitScale: 1,
      };
    },
  },

  probeInPage() {
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
    // Comma-grouping is REQUIRED. That alone rejects the change badge
    // (`+0.256%`), the raw payload integer (`268993`) and the header toggle.
    // It does NOT reject the volume column (`۴۶٬۱۴۴.51`) — so the SELECTOR is
    // the guard here, and this pattern is only the second layer.
    //
    // Accepts Latin digits + `,` (the ticker) and Persian digits + U+066C (the
    // table and the card); the live page mixes both, in both the integer and
    // the decimal part.
    const PRICE = /[\d۰-۹٠-٩]{1,3}(?:[,٬][\d۰-۹٠-٩]{3})+(?:\.[\d۰-۹٠-٩]+)?/;

    document.querySelectorAll('[data-probe]').forEach((el) => {
      el.removeAttribute('data-probe');
    });

    // Inline, NOT a module-level constant: this function is serialised into the
    // page, so it cannot reach Node module scope. Referring to one here throws
    // inside the page, and the scraper silently records the page as "not ready".
    const SUFFIX = '/trade/USDT_IRT';

    /* ---- 1. the ticker tape ----
     * Listed first because it is the price a user meets first. Note it is NOT
     * relied on: it is a scrolling marquee, so its item spends part of the
     * cycle scrolled clean out of the `overflow-x-hidden` track and is then
     * correctly reported `clipped`. The table row below is the location that
     * decides the verdict.
     */
    const tape = document.querySelector('div.marquee a[href$="' + SUFFIX + '"]');
    const tapeRaw = tape ? (norm(tape.textContent).match(PRICE) || [])[0] || null : null;
    if (tape) tape.dataset.probe = 'tape';

    /* ---- 2. the market table row (primary) ----
     * The pair comes from the trade link, NOT from the coin name — see the
     * «تتر گلد» note in the docblock. Then the price is the first div inside
     * the second <td>: cell > flex-column > <div>267,433</div>.
     */
    const rowLink = document.querySelector('table tbody tr a[href$="' + SUFFIX + '"]');
    const row = rowLink ? rowLink.closest('tr') : null;
    const cell = row ? row.children[1] : null;
    const tableEl = cell && cell.firstElementChild ? cell.firstElementChild.firstElementChild : null;
    const tableRaw = tableEl ? (norm(tableEl.textContent).match(PRICE) || [])[0] || null : null;

    if (tableEl) tableEl.dataset.probe = 'table';

    /* ---- 3. the hero card ----
     * `img[alt="USDT icon"]` is unique (the nav coin-stack uses alt="USDT").
     * Inside it, self-locate the price span rather than trusting
     * `div.mr-auto p span` — a Tailwind-class selector rots on the next design
     * change, whereas "the first span in this card that IS a price" cannot.
     *
     * This card carries `style="backdrop-filter: blur(5px)"`. That is
     * decorative glass behind the card and must NOT be treated as
     * obfuscation: backdrop-filter blurs what is BEHIND an element, not its own
     * text. The visibility check deliberately only inspects `filter`.
     */
    const cardImg = document.querySelector('img[alt="USDT icon"]');
    const card = cardImg ? cardImg.closest('a[href$="' + SUFFIX + '"]') : null;
    let cardEl = null;
    if (card) {
      const spans = card.querySelectorAll('span');
      for (let i = 0; i < spans.length; i += 1) {
        if (PRICE.test(norm(spans[i].textContent))) { cardEl = spans[i]; break; }
      }
    }
    const cardRaw = cardEl ? (norm(cardEl.textContent).match(PRICE) || [])[0] || null : null;

    if (cardEl) cardEl.dataset.probe = 'card';

    const found = !!(tape || tableEl || card);

    return {
      ready: found,
      // Unlike the compliant exchanges, this page carries a genuine live feed —
      // the same v1/pairs endpoint the SSR markup was built from.
      feedLive: found,
      probes: [
        { key: 'tape', label: 'نوار قیمت‌های لحظه‌ای', raw: tapeRaw },
        { key: 'table', label: 'ردیف تتر در جدول بازار', raw: tableRaw, primary: true },
        { key: 'card', label: 'کارت تتر در بخش شکار سود', raw: cardRaw },
      ],
    };
  },
};