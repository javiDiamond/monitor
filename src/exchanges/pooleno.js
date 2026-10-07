'use strict';

/**
 * پول نو (pooleno.ir) — adapter.
 *
 * Monitored page: https://pooleno.ir/price/usdt
 *
 * This is the cleanest compliant case we monitor: the price is not hidden, it
 * is simply never published. The slot is server-rendered as the literal glyph
 * «۰» beside the unit TMN — in the raw HTML, in the RSC flight stream, in the
 * meta description and in the JSON-LD (`"price": 0`).
 *
 * Nothing is concealed. There is no blur, no opacity-0, no mask, no per-digit
 * span, no overlay and no login gate anywhere in the document — contrast this
 * with آبان‌تتر (blurred) and صراف (display:none), where the value exists but
 * cannot be read.
 *
 * The control that proves it is deliberate rather than broken: the SAME slot
 * renders live prices for every other asset (USDC ۲۶۹,۲۰۹ / BTC ۲۲,۷۷۵,۸۱۷,۲۹۳ /
 * ETH ۷۲۱,۹۶۰,۱۲۷). Only USDT is zeroed, server-side and unconditionally.
 *
 * The slot selector is scoped precisely on purpose: bare
 * `#price-usdt-detail-summary strong` matches FOUR elements (two hero rows plus
 * two prose zeros) and would read the wrong one.
 *
 * UNIT: TMN = تومان. Note the page also prints «ریال» in unrelated prose and
 * JSON-LD tags the rate as IRR; neither is the displayed unit.
 *
 * API: deliberately none. Their endpoint responds, but it returns the same
 * zeroed rate (`rawUsdtTmnPrice: "0"`, `datasetVersion: "hidden"`), so there is
 * no independent price to cross-check — unlike the other concealing exchanges,
 * where the API still serves a real figure.
 */

const SLOT_SELECTOR = '#price-usdt-detail-summary div[dir="ltr"] > div:first-child strong';module.exports = {
  id: 'pooleno',
  name: 'پول نو',
  host: 'pooleno.ir',
  coin: 'USDT',
  market: 'USDT_TMN',
  unit: 'TMN',
  unitLabel: 'تومان',
  url: 'https://pooleno.ir/price/usdt',
  currency: 'TMN',

  api: null,

  probeInPage() {
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const PRICE = /[\d۰-۹]{1,3}(?:,[\d۰-۹]{3})+/;

    document.querySelectorAll('[data-probe]').forEach((el) => {
      el.removeAttribute('data-probe');
    });

    // Inline, NOT a module-level constant: this function is serialised into the
    // page, so it cannot reach Node module scope. Referring to one here throws
    // inside the page, and the scraper silently records the page as "not ready".
    const SLOT = '#price-usdt-detail-summary div[dir="ltr"] > div:first-child strong';

    // Exactly one element: the USDT price slot in the summary card. Scoping to
    // the slot (rather than sweeping the page) is what keeps neighbouring
    // assets — USDC, BTC, ETH — from being mistaken for the tether price.
    const slot = document.querySelector(SLOT);
    const raw = slot ? (norm(slot.textContent).match(PRICE) || [])[0] || norm(slot.textContent) : null;

    if (slot) slot.dataset.probe = 'priceSlot';

    return {
      ready: !!slot,
      feedLive: !!slot,
      probes: [
        { key: 'priceSlot', label: 'محل نمایش قیمت', raw, primary: true },
      ],
    };
  },
};
