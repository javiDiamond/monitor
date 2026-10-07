'use strict';

/**
 * والکس (wallex.ir) — adapter.
 *
 * Two behaviours of this page shape everything below, both measured live:
 *
 *   1. THE PRICE IS FLASHY, like nobitex's. The served HTML carries the real
 *      figure and the client withdraws every USDT number 1-1.5s after
 *      domcontentloaded: the headline, dollar, converter and current slots
 *      swap to «—» and the high/low rows are removed outright, while the
 *      market-volume figures keep ticking (present at 1.1s, gone by 1.5s,
 *      measured 2026-10-05). Judging the served document alone — as this
 *      adapter used to — reported a violation nobody could see. So the verdict
 *      now comes from the browser path and the shared flash-aware pipeline:
 *      price seen then withdrawn is a reported flash and «رعایت شده».
 *
 *   2. THE MAIN THREAD LOCKS ~8s after load, permanently. Every in-page
 *      evaluation after that hangs forever, so `evaluateInPage`'s ceiling
 *      discards those samples and the check simply runs on what was read
 *      before the lock. `frozenThread: true` tells the scraper to take the
 *      evidence screenshot WITHOUT the height probe, which would otherwise
 *      hang and cost the only image — the compositor keeps working after the
 *      page's JavaScript cannot.
 *
 * Selectors are anchored on caption TEXT, never on class names: the MUI classes
 * are build-hashed and the typography variant itself differs between the
 * server-rendered and hydrated markup (DisplayStrong -> TitleStrong). The scan
 * past each caption is NARROW and stops at the first placeholder, so a
 * withdrawn slot reads «—» instead of letting the scan wander into the next
 * row's numbers — and the comma-grouped volume figures can never be mistaken
 * for a price.
 */

/** The page's own embedded state — the authoritative price, for the API cross-check. */
function readNextData(html) {
  const m = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  if (!m) return null;
  try {
    const j = JSON.parse(m[1]);
    const queries = j?.props?.pageProps?.dehydratedState?.queries;
    if (!Array.isArray(queries)) return null;
    const q = queries.find(
      (x) =>
        Array.isArray(x?.queryKey) &&
        x.queryKey[0] === 'price-coin-list' &&
        Array.isArray(x.queryKey[1]) &&
        x.queryKey[1][0] === 'USDT'
    );
    const markets = q?.state?.data?.result?.markets;
    if (!Array.isArray(markets)) return null;
    const usdt = markets.find((m2) => m2 && m2.baseAsset === 'USDT');
    return usdt || null;
  } catch {
    return null;
  }
}

module.exports = {
  id: 'wallex',
  name: 'والکس',
  host: 'wallex.ir',
  coin: 'USDT',
  market: 'TMN',
  unit: 'IRT',
  unitLabel: 'تومان',
  url: 'https://wallex.ir/price/usdt',
  currency: 'IRT',

  // The main thread locks anywhere between ~1.3s and ~8s after load (see the
  // header): the evidence screenshot is taken EARLY, right after navigation
  // and without any in-page evaluation, because after the lock even the
  // compositor capture fails.
  frozenThread: true,

  api: {
    // No public price endpoint exists: /market/coins is geo-gated and returns
    // 503. The served document carries the price in __NEXT_DATA__ instead.
    url: 'https://wallex.ir/price/usdt',
    parse(text) {
      const usdt = readNextData(text);
      if (!usdt || !usdt.quotes || !usdt.quotes.TMN) return null;
      const price = Number(usdt.quotes.TMN.price);
      const change = Number(usdt.quotes.TMN.change24h);
      return {
        price: Number.isFinite(price) ? price : null,
        change: Number.isFinite(change) ? change : null,
        // Already quoted in Toman.
        unitScale: 1,
      };
    },
  },

  /**
   * Probe, serialised into the page by Playwright — must stay self-contained.
   *
   * Each caption is located among leaf elements (a caption may be a <span> or
   * a <div>, and parents are excluded so a container's longer textContent can
   * never match), then the next few leaves are scanned for the value. The scan
   * stops at the first placeholder: the slot was found and shows no price.
   */
  probeInPage() {
    // Inline, NOT module-level constants: this function is serialised into the
    // page, so it cannot reach Node module scope. Referring to one here throws
    // inside the page, and the scraper silently records the page as "not ready".
    const PRICE = /^\d{1,3}(?:,\d{3})+$/;
    const DOLLAR = /^\$[\d.,]+$/;
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();

    document.querySelectorAll('[data-probe]').forEach((el) => {
      el.removeAttribute('data-probe');
    });

    // Leaf-ish elements in document order — a value or a caption, never a
    // container whose textContent would swallow whole sections.
    const leaves = Array.from(document.querySelectorAll('span,div')).filter((e) => {
      const t = e.textContent.trim();
      if (!t) return false;
      return ![...e.children].some((c) => c.textContent.trim());
    });

    /** First value matching `pattern` within a few leaves after `caption`.
     * A placeholder (—, --, a bare dash row) is RETURNED rather than skipped:
     * the slot exists and honestly shows no price, and the dash is the finding
     * — while the scan must not wander on into the next row's numbers. */
    const PLACEHOLDER = /^[-–—_.،,%\s]+$/;
    const valueAfter = (caption, pattern) => {
      let at = leaves.findIndex((e) => norm(e.textContent) === caption);
      if (at < 0) at = leaves.findIndex((e) => norm(e.textContent).startsWith(caption));
      if (at < 0) return null;
      for (let i = at + 1; i < Math.min(at + 6, leaves.length); i += 1) {
        const t = norm(leaves[i].textContent);
        if (pattern.test(t)) return leaves[i];
        if (PLACEHOLDER.test(t)) return leaves[i];
      }
      return null;
    };

    const headlineEl = valueAfter('آخرین قیمت تتر', PRICE);
    const dollarEl = valueAfter('قیمت تتر به دلار', DOLLAR);
    const converterEl = valueAfter('برابر است با', PRICE);
    const currentEl = valueAfter('قیمت فعلی', PRICE);
    const highEl = valueAfter('بیشترین قیمت', PRICE);
    const lowEl = valueAfter('کمترین قیمت', PRICE);

    const found = [
      ['headline', headlineEl],
      ['dollar', dollarEl],
      ['converter', converterEl],
      ['current', currentEl],
      ['high', highEl],
      ['low', lowEl],
    ];
    for (const [key, el] of found) {
      if (el && !el.dataset.probe) el.dataset.probe = key;
    }

    const rawOf = (el) => (el ? norm(el.textContent) : null);

    return {
      // The headline is server-rendered, so it is there from the first sample.
      ready: !!headlineEl,
      feedLive: !!headlineEl,
      probes: [
        { key: 'headline', label: 'قیمت اصلی', raw: rawOf(headlineEl), primary: true },
        { key: 'dollar', label: 'قیمت به دلار', raw: rawOf(dollarEl) },
        { key: 'converter', label: 'قیمت تبدیل کنار صفحه', raw: rawOf(converterEl) },
        { key: 'current', label: 'قیمت فعلی', raw: rawOf(currentEl) },
        { key: 'high', label: 'بیشترین قیمت ۲۴ ساعت', raw: rawOf(highEl) },
        { key: 'low', label: 'کمترین قیمت ۲۴ ساعت', raw: rawOf(lowEl) },
      ],
    };
  },
};
