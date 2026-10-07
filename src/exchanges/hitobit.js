'use strict';

/**
 * هیتوبیت (hitobit.com) — adapter.
 *
 * Monitored page: https://hitobit.com/fa
 *
 * The simplest page in the set: the tether rate appears in exactly ONE place,
 * as plain text, with no concealment of any kind — no opacity, filter, mask,
 * clip-path, blur, or responsive-hide class anywhere in its ancestry.
 *
 *     قیمت بازار:  <span id="last-usdt-price">269,033</span>تومان
 *
 * `#last-usdt-price` is a stable id the site's OWN stylesheet targets
 * (`.ttr-price1 a #last-usdt-price { color:#FCAF17; font-weight:600 }`), and it
 * resolves to exactly one element in the markup. The unit is a bare `تومان`
 * TEXT NODE sibling, not an element — it cannot be selected, but the probe
 * confirms it is there.
 *
 * ONE REAL TIMING BEHAVIOUR, and it is not a flash: the span is server-rendered
 * as an en-dash placeholder (`–`) and the page's own JavaScript overwrites it
 * from the ticker feed about 1.5s later. Measured live:
 *
 *     t = 0ms      " – "
 *     t = 1500ms   "269,033"
 *
 * This is the ordinary case the settle loop already handles — the LAST reading
 * wins, so the placeholder is not mistaken for the final state and a real price
 * is not mistaken for a flash. No special-casing is needed; it is documented
 * here because it is the reason the settle window must not be shortened, and
 * because a shorter one would silently report this exchange as compliant.
 *
 * THE DECOYS. None of them is reachable through the id, which is the whole
 * point of anchoring on it:
 *
 *   • The market table's `.quote-sign` cells carry comma-grouped, non-zero USD
 *     prices — `2,683.310000000000` for ETH, `4,147.810000000000` for PAXG. A
 *     text sweep reads `2,683` out of that instantly. Note the class is applied
 *     broadly: percentage and volume cells carry it too.
 *   • The same table's تومان column is Persian-magnitude ABBREVIATED —
 *     `20.02 هزار تومان`, `721.90 میلیون تومان`, `1.12 میلیارد تومان` — so it
 *     cannot match a plain comma-grouped integer at all. That is luck, not
 *     design, and it is not something to rely on.
 *   • The table has NO USDT/IRT row. Its five pairs (SAND, ETH, ENJ, ETC, PAXG)
 *     are all quoted in dollars, so the string `USDT` appears in every pair
 *     label and nothing more. Verified live: `usdtRow` matches only because of
 *     labels like `SAND/USDT`.
 *   • `#dominance-btc` and `#market-cap` are SWAPPED on the live site — the id
 *     named for BTC dominance actually holds the market cap (`$ 3.30 T`), and
 *     `#market-cap` holds the dominance percentage (`% 63.69`). That is their
 *     bug, not ours; it is recorded so a future reader does not trust the ids.
 *   • Four bare counters — `99`, `151`, `+۵۰`, `3` — none of them prices.
 *
 * Confirmed absent, so a future change is noticeable: no chart (the only
 * `<canvas>` is a hidden QR code for the APK download), no price in any meta tag
 * or JSON-LD, and no price in the header, hero, footer or sidebar. The rotating
 * `.words-1` headline words are «قیمت / پشتیبانی / تنوع رمزارز» — no numbers.
 * Several CSS ids on this page are dead (`#list-price`, `.last-usdt-price` as a
 * class, `#ycd-circle-4148`) and must not be mistaken for live hooks.
 *
 * UNIT: تومان, and it is printed immediately after the number. The site's own
 * feed confirms the symbol: the pair is `USDTIRT`, and `IRT` is their Toman —
 * they migrated the quote asset from IRR to IRT, so every `*IRT` symbol there
 * is Toman.
 *
 * API: deliberately none, by the operator's standing decision. Unlike the other
 * `api: null` adapters there is a stronger reason to skip it here: the endpoint
 * is the very thing that fills this on-screen span. The page's own JS does
 *
 *     document.querySelector("#last-usdt-price").innerHTML =
 *       numberWithCommas(marketusdtirt[0].lastPrice);
 *
 * from `hitobit.com/hapi/exchange/v1/public/alltickers/24hr`, so reading that
 * endpoint back would be echoing the page's own source at us — it cannot
 * independently corroborate what is on screen. Its neighbours are also a trap
 * (`bidPrice`, `weightedAveragePrice`, `prevDayClosePrice`, the 24h range, an
 * `askPrice` that is often 0, and a `quoteVolume` of ~12 billion in Toman).
 * The screenshot is the evidence.
 */

module.exports = {
  id: 'hitobit',
  name: 'هیتوبیت',
  host: 'hitobit.com',
  coin: 'USDT',
  market: 'USDT_IRT',
  unit: 'IRT',
  unitLabel: 'تومان',
  url: 'https://hitobit.com/fa',
  currency: 'IRT',

  // See the docblock: the feed is this page's own source, not an independent one.
  api: null,

  probeInPage() {
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
    // Comma-grouping is REQUIRED. That alone rejects the en-dash placeholder,
    // the counters (`99`, `151`, `+۵۰`, `3`), the `$ 3.30 T` market cap and the
    // `% 63.69` dominance. It does NOT reject the market table's USD values
    // (`2,683.310000000000`) — so the SELECTOR is the guard and this pattern is
    // only the second layer.
    const PRICE = /[\d۰-۹٠-٩]{1,3}(?:[,٬][\d۰-۹٠-٩]{3})+(?:\.[\d۰-۹٠-٩]+)?/;

    document.querySelectorAll('[data-probe]').forEach((el) => {
      el.removeAttribute('data-probe');
    });

    // Inline, NOT a module-level constant: this function is serialised into the
    // page, so it cannot reach Node module scope. Referring to one here throws
    // inside the page, and the scraper silently records the page as "not ready".

    /* ---- the single price span ----
     * One id, one element. The unit is a bare text node after the span, which
     * no selector can reach — so we read the number from the span itself and
     * photograph the enclosing column.
     */
    const slot = document.querySelector('#last-usdt-price');
    // The fallback keeps the placeholder legible: before the page's own script
    // fills it, the span holds «–», and reporting that verbatim produces
    // «نمایش خط تیره به‌جای عدد» instead of a bare null.
    const raw = slot ? (norm(slot.textContent).match(PRICE) || [])[0] || norm(slot.textContent) : null;

    if (slot) slot.dataset.probe = 'priceSlot';

    return {
      ready: !!slot,
      feedLive: !!slot,
      probes: [
        { key: 'priceSlot', label: 'قیمت بازار: تتر', raw, primary: true },
      ],
    };
  },
};