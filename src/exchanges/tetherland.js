'use strict';

/**
 * تترلند (tetherland.com) — adapter.
 *
 * Monitored page: https://tetherland.com/
 *
 * تترلند is a straightforward violation: the tether price is rendered in plain
 * text, in the largest type on the page, directly under the caption «نرخ تتر».
 * There is no concealment of any kind to weigh — `filter: none`, `opacity: 1`,
 * `visibility: visible`, no clipping ancestor, no overlay, no login gate. This
 * is the opposite of صراف (display:none) or آبان‌تتر (blur): the number is
 * there for any anonymous visitor to read, and it is server-rendered into the
 * initial HTML rather than being fetched at runtime.
 *
 * THE INTERESTING PART IS THE PAGE FULL OF NEAR MISSES. Four of them sit within
 * a few hundred tomans of the real price, and a sloppy reader would report a
 * number that is not the tether rate:
 *
 *   #tetherMax24h        268,800   24h high — comma-grouped, 450 تومان above the price
 *   #tetherMin24h        260,450   24h low  — comma-grouped
 *   #tetherChange24h     ٪3.03     Persian percent sign FIRST, so a lax numeric
 *                                    regex happily reads `3.03` and calls it a price
 *   .cskie[data-att]     268350    the raw price again, un-commaed, in a data
 *                                    attribute on an empty span
 *   #bazzarCalcPrice     0 تومان   the "total" of an untouched calculator
 *
 * plus 22 `.price` elements in the asset carousel, of which `.tether-price .price`
 * (e.g. `84,640.3 تتر` for BTC) is itself comma-grouped and non-zero — read one
 * of those and you manufacture a violation out of nothing.
 *
 * Two defences, in this order:
 *   1. The SELECTOR. `#currentPrice` resolves to exactly one element on the page;
 *      bare `.price` resolves to 24. The selector is the real guard.
 *   2. The REGEX. Comma-grouping is mandatory, which alone rejects `3.03`,
 *      `0` and `268350` (the last has no separator at all).
 *
 * `.cskie[data-att]` is deliberately NOT probed. It is an empty span, so the
 * visibility check would report it `zero-size` and the report would then claim it
 * is «با display:none مخفی شده است» — which is false. A wrong explanation is
 * worse than no explanation; it is documented here and in the README instead.
 *
 * The period switcher (`24ساعت` with prev/next arrows) contains no sibling price
 * node, and we never click it — consistent with the standing rule on tabs and
 * carousels.
 *
 * UNIT: TMN = تومان. There is no «ریال» used as a currency anywhere on the page,
 * and the API corroborates the scale independently: `last24hMax: 268800` is the
 * same figure the page labels «بالاترین».
 */

module.exports = {
  id: 'tetherland',
  name: 'تترلند',
  host: 'tetherland.com',
  coin: 'USDT',
  market: 'USDT_TMN',
  unit: 'TMN',
  unitLabel: 'تومان',
  url: 'https://tetherland.com/',
  currency: 'TMN',

  api: {
    // A bare GET, no auth — the same call the homepage itself makes on load to
    // fill this price in. Unlike the exchanges that suppress the price while
    // still serving it here, تترلند publishes it everywhere at once.
    url: 'https://service.tetherland.com/api/v4/currencies',
    parse(text) {
      const json = JSON.parse(text);
      // This endpoint is the tether rate and nothing else — there is no coin
      // wrapper and no envelope, the object IS the quote. `price`, `buy_price`
      // and `sell_price` are all 268350 at the time of writing.
      //
      // Read `price` only. `last24hMax` (268800) and `last24hMin` (260450) are
      // the very figures the page prints as «بالاترین» and «پایین ترین», and
      // `diff24d` ("3.03") is the «٪3.03» change badge — all three sit in this
      // same object, so an over-broad parse here would be the same mistake the
      // page-level probe exists to prevent.
      const price = Number(json.price);
      const change = Number(json.diff24d);
      return {
        price: Number.isFinite(price) ? price : null,
        change: Number.isFinite(change) ? change : null,
        // Quoted in تومان.
        unitScale: 1,
      };
    },
  },

  probeInPage() {
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
    // Comma-grouping is REQUIRED. That single constraint rejects the 24h change
    // ("3.03"), the empty calculator total ("0"), and the raw data-attribute
    // value ("268350", which carries no separator) — while matching "268,350".
    // Arabic-Indic digits are accepted too: the page renders Latin digits today,
    // but that is a client-side formatting choice and is free to change.
    const PRICE = /[\d۰-۹٠-٩]{1,3}(?:[,٬][\d۰-۹٠-٩]{3})+(?:\.\d+)?/;

    document.querySelectorAll('[data-probe]').forEach((el) => {
      el.removeAttribute('data-probe');
    });

    // Inline, NOT a module-level constant: this function is serialised into the
    // page, so it cannot reach Node module scope. Referring to one here throws
    // inside the page, and the scraper silently records the page as "not ready".
    //
    // `#currentPrice` resolves to exactly ONE element. Bare `.price` resolves to
    // 24 on this page, of which 22 are other assets in the carousel.
    const slot = document.querySelector('#currentPrice');
    const raw = slot ? (norm(slot.textContent).match(PRICE) || [])[0] || norm(slot.textContent) : null;

    // Probe the number itself: the question we must answer is "can a user read
    // THIS digit string?", so visibility is asked about the tightest element.
    if (slot) slot.dataset.probe = 'priceSlot';

    return {
      ready: !!slot,
      // The opposite of the compliant exchanges: this page really does carry a
      // live feed — `tetherPriceSpan.js` polls the same v4 endpoint the page
      // already rendered from — so a feed here is expected, not a warning sign.
      feedLive: !!slot,
      probes: [
        { key: 'priceSlot', label: 'قیمت تتر در بالای صفحه', raw, primary: true },
      ],
    };
  },
};