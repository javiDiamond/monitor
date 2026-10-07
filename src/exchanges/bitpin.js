'use strict';

/**
 * بیت‌پین (bitpin.ir) — adapter.
 *
 * The USDT price appears in two places on the homepage: the market table row
 * "USDT / IRT", and the horizontally scrollable ticker strip. Both are read.
 */
module.exports = {
  id: 'bitpin',
  name: 'بیت‌پین',
  host: 'bitpin.ir',
  coin: 'USDT',
  market: 'USDT_IRT',
  url: 'https://bitpin.ir/',
  currency: 'IRT',
  unit: 'IRT',
  unitLabel: 'تومان',

  // The market table is the last thing on this page to render — a heavy
  // client-side island behind the hero — so `settleMs` (4s) can expire before it
  // appears, and the probe never reports ready at all. The ticker is present
  // from SSR but CANNOT stand in for the table: the table is where a price
  // flash happens, and judging on the ticker alone would risk missing a real
  // violation. So wait longer for the table rather than trusting the ticker.
  // Env-tunable because the render time is a property of the site.
  readyTimeoutMs: Number(process.env.BITPIN_READY_TIMEOUT_MS || 12_000),

  api: {
    url: 'https://api.bitpin.ir/v5/mkt/markets/?quote=IRT&limit=10&exclude_tags=57',
    parse(text) {
      const json = JSON.parse(text);
      const results = Array.isArray(json) ? json : (json && json.results) || [];
      const m = results.find((r) => r && r.code === 'USDT_IRT');
      if (!m || !m.price_info) return null;
      const price = Number(m.price_info.price);
      const change = Number(m.price_info.change);
      return {
        price: Number.isFinite(price) ? price : null,
        change: Number.isFinite(change) ? change : null,
        // bitpin already quotes this market in Toman.
        unitScale: 1,
      };
    },
  },

  /**
   * Runs in the page (serialized, so it must be self-contained).
   * Tags the two elements we read so they can be screenshotted afterwards.
   */
  probeInPage({ coin }) {
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
    // This probe runs many times per page load; clear earlier tags first so a
    // screenshot selector can never match more than one element.
    document.querySelectorAll('[data-probe]').forEach((el) => {
      el.removeAttribute('data-probe');
    });
    const digits = (s) =>
      String(s || '')
        .replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
        .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
    const num = (s) => {
      const n = Number(digits(s).replace(/[^\d.]/g, ''));
      return Number.isFinite(n) ? n : 0;
    };

    const rows = [...document.querySelectorAll('tr')]
      .map((tr) => {
        const tds = [...tr.querySelectorAll('td')];
        const m = norm(tr.innerText).match(/^([A-Z0-9]+)\s*\/\s*IRT/);
        if (!m) return null;
        return {
          code: m[1],
          price: tds[1] ? norm(tds[1].innerText) : '',
          el: tr,
        };
      })
      .filter(Boolean);

    const row = rows.find((r) => r.code === coin) || null;
    if (row) {
      row.el.dataset.probe = 'row';
    }

    const links = [...document.querySelectorAll(`a[href="/coin/${coin}/"]`)];
    const tel =
      links.find((a) => String(a.className).includes('basis-80')) ||
      links.find((a) => /\(.*\)/.test(norm(a.innerText))) ||
      null;

    let tickerRaw = null;
    if (tel) {
      tel.dataset.probe = 'ticker';

      // The ticker lays out three slots in this order: coin label, price,
      // change. The change is the parenthesised group and it always wraps a
      // nested <span> holding the percentage, so it is identified STRUCTURALLY,
      // never by shape — a price rendered as a bare `-` is identical to a
      // negative change, and guessing by shape either reads the change as the
      // price or throws the price away.
      const slots = [...tel.children].filter((el) => el.tagName === 'SPAN');
      const hasDigit = (s) => /[۰-۹0-9]/.test(s);
      const labelAt = slots.findIndex((s) => {
        const t = norm(s.textContent);
        return t !== '' && !hasDigit(t);
      });
      const rest = labelAt >= 0 ? slots.slice(labelAt + 1) : slots;
      // The change comes last in this layout, so the price is the slot right
      // before it. `wrapsChange` is the structural test and is tried first;
      // `looksSigned` is the shape fallback, used only when no slot wraps a
      // nested span. A lone signed-looking slot directly after the label is a
      // DASH PRICE, not a change with no price beside it, so index 0 is skipped
      // in the fallback.
      const findChange = (wrapTest, skipFirst) => {
        for (let i = rest.length - 1; i >= 0; i -= 1) {
          if (skipFirst && i === 0) continue;
          if (wrapTest(rest[i])) return i;
        }
        return -1;
      };
      const wrapsChange = (el) => !!el.querySelector('span');
      const looksSigned = (el) => /^[(\-+−–—]/.test(norm(el.textContent));
      let at = findChange(wrapsChange, false);
      if (at < 0) at = findChange(looksSigned, true);
      const priceEl =
        at > 0 ? rest[at - 1] : at < 0 && rest.length ? rest[rest.length - 1] : null;
      // '' rather than null: the slot was there and held nothing. buildDetail
      // renders it «خالی», which is what separates "the price is withheld" from
      // "this surface is not on the page at all" — two cases that look
      // identical when a probe is simply omitted.
      tickerRaw = priceEl ? norm(priceEl.textContent) : '';
    }

    return {
      ready: !!row,
      feedLive: rows.some((r) => r.code !== coin && num(r.price) > 0),
      probes: [
        { key: 'row', label: 'جدول بازار', raw: row ? row.price : null, primary: true },
        { key: 'ticker', label: 'نوار قیمت', raw: tickerRaw, primary: false },
      ],
    };
  },
};