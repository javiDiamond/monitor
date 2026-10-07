'use strict';

/**
 * Shared adapter for the "Estedad" white-label exchange platform.
 *
 * Two monitored exchanges run the same front end with different branding:
 *
 *   - راستین   raastin.com/price/tether   → no price anywhere on the page,
 *     except that the buy converter computes one the moment a user types
 *   - ارزپلاس  panel.arzplus.net/price/tether → same front end, same converter
 *
 * The DOM, the caption strings and the JSON shape of the market feed are
 * identical, so the probe and the API parser live here once. Each tenant is a
 * few lines of configuration in its own file.
 *
 * LAYOUT HISTORY. The page this probe originally read printed the tether
 * price in four static places (headline ticker, «قیمت تتر» summary row,
 * «قیمت (تومان)» stats row, SEO prose). That design is gone: today neither
 * tenant displays the price anywhere at rest. The ONLY toman figure the page
 * will produce is in the buy converter (`#price-trade`): type "1" into the
 * tether («دریافت می‌کنم») field and the field above it («پرداخت می‌کنم»,
 * IRT) fills with the toman price. A user can reach that figure in two
 * clicks, so the probe performs exactly that interaction on every sample —
 * type 1 into the tether field, read the toman field.
 *
 * Two traps this probe is built to survive, both confirmed on the live sites:
 *
 *   1. PERSIAN TEXT NORMALISATION. Captions separate words with a real space
 *      or a ZWNJ (U+200C), and React splits some across text nodes. A
 *      hand-typed literal can match ZERO elements and fail silently. Every
 *      comparison normalises both sides first.
 *
 *   2. DECOYS. The document carries comma-grouped integers inside framework
 *      bootstrap <script> blocks (JS constants, not prices), stale article
 *      prices in sibling cards, and the injected "1" itself. Nothing here
 *      ever sweeps the document: the only value read is the toman input of
 *      the converter, located through its own captions.
 *
 * UNIT: these pages quote IRT, the platform's ticker for the TOMAN market.
 * The converter's output lands in the same 262k–270k Toman band every other
 * monitored exchange reports for 1 USDT, and the API's `price_irt` agrees
 * with it to the toman.
 */

/**
 * Probe, serialised into the page by Playwright — must stay self-contained.
 *
 * NOTE: this probe is INTERACTIVE. It types into the page (the converter's
 * tether field), which no other adapter's probe does. The typing is the exact
 * action a site visitor would perform, it is idempotent (only fires when the
 * field is empty), and the value it produces is judged by the same
 * visibility-checked pipeline as every static surface.
 */
function probeWhiteLabelPage() {
  // Delete invisible formatting and promote ZWNJ to a space, so "پرداخت می‌کنم"
  // and "پرداخت می کنم" compare equal. Written as escapes: literal invisible
  // characters would be unreadable and easy to corrupt in transit.
  const FORMATTING = /[\u200B\u200D\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;
  const norm = (s) =>
    (s || '')
      .replace(FORMATTING, '')
      .replace(/\u200C/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

  // Strictly a comma-grouped integer, so a bare "1" or "0%" is never a price.
  const PRICE = /^\d{1,3}(?:,\d{3})+$/;

  document.querySelectorAll('[data-probe]').forEach((el) => {
    el.removeAttribute('data-probe');
  });

  /* ---- the buy converter ----
   * Two amount inputs inside #price-trade, DOM order following the cards:
   * «پرداخت می‌کنم» (IRT — the toman figure) first, «دریافت می‌کنم»
   * (USDT — the tether amount) second. Anchored on the caption texts, not on
   * classes (build-hashed) or index alone (a redesign that reorders the cards
   * would otherwise make us type into the wrong box). */
  const tradePanel = document.querySelector('#price-trade');
  const captionIn = (text) =>
    tradePanel
      ? [...tradePanel.querySelectorAll('label')].find(
          (l) => norm(l.textContent) === norm(text)
        ) || null
      : null;
  const inputs = tradePanel ? [...tradePanel.querySelectorAll('input')] : [];
  const structured = !!(
    captionIn('پرداخت می\u200Cکنم') &&
    captionIn('دریافت می\u200Cکنم') &&
    inputs.length >= 2
  );
  const payInput = structured ? inputs[0] : null;
  const receiveInput = structured ? inputs[1] : null;

  // Type "1" into the tether field, the way a visitor would. React ignores a
  // plain `.value =` write, hence the native setter. Re-fired for as long as
  // the toman figure is missing, which covers two timing traps observed live:
  //
  //   - pre-hydration, the input event has no listener yet, so the first fill
  //     does nothing — and the typed "1" survives in the DOM into hydration,
  //     where React's change tracker adopts it as the value it last saw. From
  //     then on a re-dispatch of the SAME '1' is deduped and swallowed, so the
  //     converter never computes. The field is therefore toggled: cleared and
  //     re-typed, so the tracker always sees a transition.
  //
  //   - a re-render that clears either field must not end the disclosure.
  //
  // Once the figure is on screen the probe stops touching the page.
  if (receiveInput && !(payInput && norm(payInput.value))) {
    try {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value'
      ).set;
      const inputEvent = () => new Event('input', { bubbles: true });
      if (norm(receiveInput.value) === '1') {
        setter.call(receiveInput, '');
        receiveInput.dispatchEvent(inputEvent());
      }
      setter.call(receiveInput, '1');
      receiveInput.dispatchEvent(inputEvent());
    } catch {
      /* retried on the next sample */
    }
  }

  // The toman figure — the only value this probe reads. The converter computes
  // it a tick after the input event, so the first sample may still see it
  // empty; the sampling loop reads it again 350ms later.
  const payValue = payInput ? norm(payInput.value) : null;
  if (payInput) payInput.dataset.probe = 'converter';

  return {
    // Both cards present means the page rendered; the converter is part of the
    // server response, so this does not wait on hydration.
    ready: !!structured,
    feedLive: !!structured && PRICE.test(payValue || ''),
    probes: [
      {
        key: 'converter',
        label: 'ماشین‌حساب خرید (بابت ۱ تتر)',
        raw: structured ? payValue : null,
        primary: true,
      },
    ],
  };
}

/** The market feed, identical in shape across tenants of this platform. */
function parseOverview(text) {
  const json = JSON.parse(text);
  const rows = (json && json.high_volume) || [];
  // Index by symbol: the array order is not stable between requests.
  const usdt = rows.find((r) => r && r.symbol === 'USDT');
  if (!usdt) return null;
  const price = Number(usdt.price_irt);
  const change = Number(usdt.change_24h_irt);
  return {
    price: Number.isFinite(price) ? price : null,
    change: Number.isFinite(change) ? change : null,
    // Quoted in Toman.
    unitScale: 1,
  };
}

/**
 * Build an adapter for one tenant of this platform.
 * Only identity and endpoints differ between tenants.
 */
function createAdapter({ id, name, host, url, apiUrl }) {
  return {
    id,
    name,
    host,
    coin: 'USDT',
    market: 'USDT_IRT',
    unit: 'IRT',
    unitLabel: 'تومان',
    url,
    currency: 'IRT',
    whiteLabel: true,
    probeInPage: probeWhiteLabelPage,
    api: { url: apiUrl, parse: parseOverview },
  };
}

module.exports = { createAdapter, probeWhiteLabelPage, parseOverview };
