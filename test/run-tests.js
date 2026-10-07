'use strict';

/**
 * Exercises both verdict branches against a local page with bitpin's DOM shape,
 * plus the flash-detection rule (a price that appears only while the page is
 * still rendering must not count as a violation).
 */

const http = require('http');

const { classifyValue, buildReport } = require('../src/diagnose');

const checks = [];
function assert(name, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  checks.push(pass);
  console.log(
    `  ${pass ? 'PASS' : 'FAIL'}  ${name} -> ${JSON.stringify(actual)}${
      pass ? '' : ` (expected ${JSON.stringify(expected)})`
    }`
  );
}

/* ---------- value classification ---------- */

console.log('=== classifyValue ===');
assert('persian number', classifyValue('۲۶۱,۵۰۰').value, 261500);
assert('latin number', classifyValue('262,620').value, 262620);
assert('dash', classifyValue('-').code, 'placeholder');
assert('triple dash', classifyValue('---').code, 'placeholder');
assert('persian zero', classifyValue('۰').code, 'zero');
assert('latin zero', classifyValue('0').code, 'zero');
assert('empty', classifyValue('').code, 'empty');
assert('text', classifyValue('abc').code, 'unparseable');
assert('with unit', classifyValue('۲۶۱,۵۰۰ تومان').value, 261500);
assert('negative', classifyValue('-۵').code, 'negative');
assert('null', classifyValue(null).code, 'absent');

/* ---------- verdicts from a settled page read ---------- */

const scrapeOk = (over = {}) => ({
  exchangeId: 'x',
  ready: true,
  feedLive: true,
  probes: {
    heading: { label: 'قیمت بالای صفحه', raw: '۲۶۱,۵۰۰', primary: true },
  },
  flashed: { detected: false, price: null, durationMs: 0 },
  ...over,
});

const apiPrice = { ok: true, price: 262000, change: 1.2, error: null };

console.log('\n=== price shown, policy=hidden (VIOLATION) ===');
const shown = buildReport({ scrape: scrapeOk(), api: apiPrice, expect: 'hidden' });
console.log('  ' + shown.title);
console.log('  ' + shown.description);
assert('state', shown.state, 'violation');
assert('priceVisible', shown.priceVisible, true);
assert('price', shown.price.value, 261500);
assert('formatted', shown.price.formatted, '۲۶۱,۵۰۰');
assert('no flash note', shown.flashNote, null);

console.log('\n=== price shown, policy=shown (COMPLIANT) ===');
assert('state', buildReport({ scrape: scrapeOk(), api: null, expect: 'shown' }).state, 'compliant');

console.log('\n=== price hidden, policy=hidden (COMPLIANT) ===');
const hiddenProbes = {
  heading: { label: 'قیمت بالای صفحه', raw: '0', primary: true },
  chart: { label: 'نمودار قیمت', raw: '---', primary: false },
  bestBuy: { label: 'بهترین قیمت خرید', raw: '۰', primary: false },
};
const hidden = buildReport({
  scrape: scrapeOk({ probes: hiddenProbes }),
  api: apiPrice,
  expect: 'hidden',
});
console.log('  ' + hidden.title);
console.log('  ' + hidden.description);
assert('state', hidden.state, 'compliant');
assert('priceVisible', hidden.priceVisible, false);
assert('price', hidden.price, null);
assert('reason comes from the primary probe', hidden.reasonLabel, 'نمایش صفر به‌جای قیمت');

console.log('\n=== price hidden, policy=shown (VIOLATION) ===');
assert(
  'state',
  buildReport({ scrape: scrapeOk({ probes: hiddenProbes }), api: null, expect: 'shown' }).state,
  'violation'
);

console.log('\n=== flash: price shown only during render (must PASS) ===');
const flashed = buildReport({
  scrape: scrapeOk({
    probes: hiddenProbes, // settled value: no price
    flashed: { detected: true, price: '262,000', durationMs: 1600 },
  }),
  api: apiPrice,
  expect: 'hidden',
});
console.log('  state: ' + flashed.state);
console.log('  ' + flashed.flashNote);
assert('still compliant', flashed.state, 'compliant');
assert('priceVisible false', flashed.priceVisible, false);
assert(
  'flash note present',
  typeof flashed.flashNote === 'string' && flashed.flashNote.includes('حذف شد'),
  true
);
assert(
  'flash note uses persian digits',
  flashed.flashNote.includes('۲۶۲,۰۰۰'),
  true
);

console.log('\n=== unreachable / not ready (UNKNOWN) ===');
const unreachable = buildReport({ scrape: { navError: 'timeout', exchangeId: 'x' }, api: null, expect: 'hidden' });
assert('unreachable state', unreachable.state, 'unknown');
const notReady = buildReport({
  scrape: { exchangeId: 'x', ready: false, probes: {}, flashed: { detected: false } },
  api: null,
  expect: 'hidden',
});
assert('not-ready state', notReady.state, 'unknown');
const stalled = buildReport({
  scrape: scrapeOk({ probes: hiddenProbes, feedLive: false }),
  api: null,
  expect: 'hidden',
});
assert('feed stalled is unknown, not compliant', stalled.state, 'unknown');

console.log('\n=== «نامشخص» carries the surfaces it looked at ===');
// The log entry that started this investigation said only «بخش قیمت در صفحه
// ظاهر نشد.» with an empty detail, which left "the price is withheld" and "the
// page never rendered" looking identical. Both feed_stalled branches carry the
// per-surface readings in `probes` — which the detail page renders as rows.
// The separate `detail` string is deliberately GONE here: it said exactly what
// the probe rows say, and duplicated information gets removed, not restyled.
// An ABSENT surface (null) is still worded differently from an empty one («خالی»)
// in the report's description logic — the distinction lives in the probe values.
{
  const surfaced = buildReport({
    scrape: scrapeOk({
      ready: false,
      probes: {
        row: { label: 'جدول بازار', raw: null, primary: true },
        ticker: { label: 'نوار قیمت', raw: '', primary: false },
      },
    }),
    api: null,
    expect: 'hidden',
  });
  assert('no duplicated detail string', surfaced.detail == null, true);
  assert('both surfaces are carried for the page to render', Object.keys(surfaced.probes).length, 2);
  assert('an absent surface stays absent', surfaced.probes.row.raw, null);
  assert('an empty surface stays empty', surfaced.probes.ticker.raw, '');
}
{
  // Ready but the feed never came alive and nothing is visible: same shape.
  const lateStall = buildReport({
    scrape: scrapeOk({ probes: { row: { label: 'جدول بازار', raw: '', primary: true } }, feedLive: false }),
    api: null,
    expect: 'hidden',
  });
  assert('the second stalled branch carries probes too', Object.keys(lateStall.probes).length, 1);
  assert('...and no duplicated detail', lateStall.detail == null, true);
}
{
  // Nothing rendered at all — the DESCRIPTION says so; there is no detail string.
  const nothing = buildReport({
    scrape: { exchangeId: 'x', ready: false, probes: {}, flashed: { detected: false } },
    api: null,
    expect: 'hidden',
  });
  assert('no surfaces still explains itself', nothing.description.includes('ظاهر نشد'), true);
  assert('...without a detail string', nothing.detail == null, true);
}

console.log('\n=== a server error is NOT a rendering problem ===');
// اتراکس returned 503 on its tether route while every sibling route was fine.
// Without this branch it was reported as «بخش قیمت در صفحه ظاهر نشد», which
// reads like the page failed to render rather than the server refusing it.
{
  const httpFail = buildReport({
    scrape: { exchangeId: 'x', ready: false, feedLive: false, probes: {}, httpStatus: 503, flashed: { detected: false } },
    api: null, expect: 'hidden',
  });
  assert('a 5xx is unknown, not compliant', httpFail.state, 'unknown');
  assert('...with its own reason code', httpFail.reasonCode, 'http_error');
  assert('...naming the status in Persian', httpFail.description.includes('۵۰۳'), true);
  assert('a server error is unknown', httpFail.state, 'unknown');
  assert('...carrying the raw status in the description', httpFail.description.includes('۵۰۳'), true);
  assert('...and httpStatus on the report', httpFail.httpStatus, 503);
}
{
  const http404 = buildReport({
    scrape: { exchangeId: 'x', ready: false, probes: {}, httpStatus: 404, flashed: { detected: false } },
    api: null, expect: 'hidden',
  });
  assert('a 4xx is also http_error', http404.reasonCode, 'http_error');
  assert('...naming 404', http404.description.includes('۴۰۴'), true);
}
// A 503 must beat the generic not-ready path, but a 200 must not trigger it.
{
  const ok200 = buildReport({ scrape: scrapeOk({ httpStatus: 200 }), api: apiPrice, expect: 'hidden' });
  assert('a 200 does not trigger the branch', ok200.reasonCode, 'shown');
  const noStatus = buildReport({ scrape: scrapeOk(), api: apiPrice, expect: 'hidden' });
  assert('no status at all does not trigger it', noStatus.reasonCode, 'shown');
  assert('reports carry httpStatus null when unknown', noStatus.httpStatus, null);
}

console.log('\n=== an unverifiable page is never a verdict ===');
// The scraper now discards any sample whose visibility check failed. If NO
// sample verified there is no evidence at all — and the worst acceptable
// outcome is «نامشخص», never a possible false violation.
{
  const blind = buildReport({
    scrape: scrapeOk({ visibilityError: 'بررسی قابلیت دیدن ناموفق بود: boom' }),
    api: apiPrice, expect: 'hidden',
  });
  assert('unverifiable visibility -> unknown', blind.state, 'unknown');
  assert('...with its own reason code', blind.reasonCode, 'visibility_error');
  assert('...not a violation', blind.priceVisible, false);
  assert('...carrying the underlying error', blind.detail.includes('boom'), true);
}
{
  // Even when the page looks ready AND the probes carry a price, an
  // unverifiable visibility check must win over the violation reading.
  const blindButPriced = buildReport({
    scrape: scrapeOk({ visibilityError: 'boom' }),
    api: apiPrice, expect: 'hidden',
  });
  assert('a price on an unverifiable page is not a violation', blindButPriced.state, 'unknown');
}
// Ordering: navError still wins, because the page never loaded at all.
{
  const navAndBlind = buildReport({
    scrape: { navError: 'timeout', exchangeId: 'x', visibilityError: 'boom', httpStatus: 503 },
    api: null, expect: 'hidden',
  });
  assert('navError outranks the visibility failure', navAndBlind.reasonCode, 'unreachable');
}
{
  // A healthy page with no visibilityError is untouched.
  const healthy = buildReport({ scrape: scrapeOk(), api: apiPrice, expect: 'hidden' });
  assert('a normal page is unaffected', healthy.state, 'violation');
}

console.log('\n=== observation judging (load-flash handling) ===');
const { judgeObservation } = require('../src/scraper');
const r = (at, any, primary) => ({ at, any, primary });

// The ordinary case: price flashes then disappears -> NOT a violation.
{
  const j = judgeObservation([
    r(0, true, '262,000'), r(350, true, '262,000'), r(1600, true, '262,000'),
    r(1950, false, '0'), r(2300, false, '0'), r(3000, false, '0'),
  ]);
  assert('flash -> no price', j.finalAny, false);
  assert('flash detected', j.flashed.detected, true);
  assert('flash price recorded', j.flashed.price, '262,000');
  assert('flash duration ms', j.flashed.durationMs, 1600);
}

// A SLOW blanking that lands after the settle window — this is the case a
// fixed settle window used to report as a violation.
{
  const j = judgeObservation([
    r(0, true, '263,498'), r(2000, true, '263,498'), r(3000, true, '263,498'),
    r(3800, false, '0'), r(4200, false, '0'),
  ]);
  assert('late flash -> no price', j.finalAny, false);
  assert('late flash detected', j.flashed.detected, true);
  assert('late flash duration', j.flashed.durationMs, 3000);
}

// A genuine, persistent price -> a real violation, and no flash note.
{
  const j = judgeObservation([
    r(0, true, '261,500'), r(1500, true, '261,480'), r(3000, true, '261,510'),
    r(6000, true, '261,500'),
  ]);
  assert('persistent price -> violation', j.finalAny, true);
  assert('no flash when persistent', j.flashed.detected, false);
}

// Never showed a price at all.
{
  const j = judgeObservation([r(0, false, '0'), r(3000, false, '0')]);
  assert('always hidden', j.finalAny, false);
  assert('no flash', j.flashed.detected, false);
  assert('sawPrice false', j.sawPrice, false);
}

console.log('\n=== ramzinex-shaped pages ===');
const rxProbes = (headline, carousel) => ({
  headline: { label: 'قیمت تتر (بالای صفحه)', raw: headline, primary: true },
  carousel: { label: 'بازار معاملاتی', raw: carousel, primary: false },
});

const rxScrapes = (probes) => ({
  exchangeId: 'ramzinex', ready: true, feedLive: true,
  probes, flashed: { detected: false, price: null, durationMs: 0 }, durationMs: 3000,
});

const rxApi = { ok: true, price: 262000, change: null, error: null };

/**
 * A miniature wallex-shaped SSR document: the caption markup, the value spans,
 * and a __NEXT_DATA__ blob carrying the authoritative price.
 */
function wxHtml(o = {}) {
  const v = {
    headline: '258,118', dollar: '$1', converter: '258,118',
    current: '258,117', high: '258,138', low: '257,951', ...o,
  };
  return `<!doctype html><html lang="fa" dir="rtl"><body>
<div><div>
  <span>آخرین قیمت تتر</span><span>(بروزرسانی هر ۳۰ ثانیه)</span>
</div><div>
  <div class="mui-1v13ntz"><span>${v.headline}</span></div>
  <div>تومان</div>
</div></div>
<div><div><span>قیمت تتر به دلار</span></div>
  <div class="mui-wmne9r"><span>${v.dollar}</span></div></div>
<div><div>
  <div>قیمت تتر به تومان</div>
  <div>برابر است با: </div>
  <div><span>${v.converter}</span> </div>
</div></div>
<div><span>قیمت فعلی</span><div><span>${v.current}</span></div></div>
<div><span>بیشترین قیمت (۲۴ ساعت)</span><span>${v.high}</span></div>
<div><span>کمترین قیمت (۲۴ ساعت)</span><span>${v.low}</span></div>
</body></html>
<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
  props: {
    pageProps: {
      dehydratedState: {
        queries: [
          {
            queryKey: ['price-coin-list', ['USDT', 'quotes']],
            state: {
              data: {
                result: {
                  markets: [
                    { baseAsset: 'BTC', quotes: { TMN: { price: '223339954126' } } },
                    { baseAsset: 'USDT', quotes: { TMN: { price: '258117.8690078500000000', change24h: '0.52' } } },
                  ],
                },
              },
            },
          },
        ],
      },
    },
  },
})}</script>`;
}

// Headline blanked, carousel still priced -> a breach, in ریال.
{
  const r = buildReport({
    scrape: rxScrapes(rxProbes('--', '2,625,000')),
    api: rxApi, expect: 'hidden', unitLabel: 'ریال',
  });
  console.log('  ' + r.title);
  console.log('  ' + r.description);
  assert('carousel price = violation', r.state, 'violation');
  assert('priceVisible', r.priceVisible, true);
  assert('price value', r.price.value, 2625000);
  assert('unit is ریال', r.price.unit, 'ریال');
  assert('named location', r.price.source, 'بازار معاملاتی');
}

// Both blanked -> compliant.
{
  const r = buildReport({
    scrape: rxScrapes(rxProbes('--', '0')),
    api: rxApi, expect: 'hidden', unitLabel: 'ریال',
  });
  console.log('  ' + r.title);
  assert('all hidden = compliant', r.state, 'compliant');
  assert('reason names the dash', r.reasonLabel, 'نمایش خط تیره به‌جای عدد');
}

// Headline blanked but carousel blanked too, with a flash -> still compliant.
{
  const s = rxScrapes(rxProbes('--', '0'));
  s.flashed = { detected: true, price: '2,619,997', durationMs: 1400 };
  const r = buildReport({ scrape: s, api: rxApi, expect: 'hidden', unitLabel: 'ریال' });
  assert('flash still compliant', r.state, 'compliant');
  assert('flash note kept', r.flashNote.includes('۲,۶۱۹,۹۹۷'), true);
}

console.log('\n=== visibility gating ===');
// A price sitting in the DOM but off-screen/clipped must NOT be a violation.
{
  const scrape = scrapeOk({
    probes: {
      heading: { label: 'قیمت بالای صفحه', raw: '--', primary: true, visible: true },
      carousel: { label: 'بازار معاملاتی', raw: '2,625,000', primary: false, visible: false },
    },
  });
  const r = buildReport({ scrape, api: rxApi, expect: 'hidden', unitLabel: 'ریال' });
  console.log('  ' + r.title);
  console.log('  ' + r.description);
  assert('hidden price is not a violation', r.state, 'compliant');
  assert('priceVisible false', r.priceVisible, false);
  assert('hidden price is called out', r.description.includes('قابل مشاهده نیست'), true);
  assert('hidden price value surfaced', r.description.includes('۲,۶۲۵,۰۰۰'), true);
}

// Same price, but actually visible -> violation.
{
  const scrape = scrapeOk({
    probes: {
      heading: { label: 'قیمت بالای صفحه', raw: '--', primary: true, visible: true },
      carousel: { label: 'بازار معاملاتی', raw: '2,625,000', primary: false, visible: true },
    },
  });
  const r = buildReport({ scrape, api: rxApi, expect: 'hidden', unitLabel: 'ریال' });
  assert('visible price is a violation', r.state, 'violation');
  assert('named location', r.price.source, 'بازار معاملاتی');
}

// Absent visibility means "unknown", so it is treated as visible (back-compat).
{
  const scrape = scrapeOk({
    probes: { heading: { label: 'قیمت بالای صفحه', raw: '۲۶۱,۵۰۰', primary: true } },
  });
  const r = buildReport({ scrape, api: null, expect: 'hidden' });
  assert('undefined visibility = visible', r.state, 'violation');
}


console.log('\n=== wallex: verdicts from the browser path ===');
const wallex = require('../src/exchanges/wallex');
const wxApi = { ok: true, price: 258118, change: 0.5, error: null };
const wxProbes = (o) => Object.fromEntries(
  Object.entries({
    headline: 'قیمت اصلی', dollar: 'قیمت به دلار', converter: 'قیمت تبدیل کنار صفحه',
    current: 'قیمت فعلی', high: 'بیشترین قیمت ۲۴ ساعت', low: 'کمترین قیمت ۲۴ ساعت',
  }).map(([k, label]) => [k, { label, raw: o[k], primary: k === 'headline', visible: true }])
);

// A page that discloses the price in every location -> violation.
{
  const r = buildReport({
    scrape: {
      exchangeId: 'wallex', ready: true, feedLive: true, durationMs: 900,
      probes: wxProbes({ headline: '258,118', dollar: '$1', converter: '258,118', current: '258,117', high: '258,138', low: '257,951' }),
      flashed: { detected: false },
    },
    api: wxApi, expect: 'hidden', unitLabel: 'تومان',
  });
  assert('state', r.state, 'violation');
  assert('price', r.price.formatted, '۲۵۸,۱۱۸');
  assert('unit', r.price.unit, 'تومان');
  assert('source', r.price.source, 'قیمت اصلی');
}

// Every price withdrawn (dashes, sections removed) -> compliant. This is the
// verdict the measured flash now produces: the SSR price counts only while it
// is on screen, and the flash note reports the glimpse.
{
  const r = buildReport({
    scrape: {
      exchangeId: 'wallex', ready: true, feedLive: true, durationMs: 900,
      probes: wxProbes({ headline: '—', dollar: '—', converter: '—', current: null, high: null, low: null }),
      flashed: { detected: true, price: '258,118', durationMs: 1200 },
    },
    api: wxApi, expect: 'hidden', unitLabel: 'تومان',
  });
  assert('all withdrawn -> compliant', r.state, 'compliant');
  assert('priceVisible', r.priceVisible, false);
  assert('flash note kept', r.flashNote.includes('۲۵۸,۱۱۸'), true);
}

// Sampling ended by the page freezing its main thread while the last reading
// still showed the price -> the documented LOAD FLASH, «رعایت شده»: this page
// withdraws the figure right after load, and the freeze only hid that moment
// from the check. Never a violation from a reading the page was about to
// withdraw.
{
  const r = buildReport({
    scrape: {
      exchangeId: 'wallex', ready: true, feedLive: true, durationMs: 4000, frozenEnded: true,
      probes: wxProbes({ headline: '258,118', dollar: '$1', converter: '258,118', current: null, high: null, low: null }),
      flashed: { detected: false },
    },
    api: wxApi, expect: 'hidden', unitLabel: 'تومان',
  });
  console.log('  ' + r.title);
  assert('a frozen flash reads as compliance', r.state, 'compliant');
  assert('reason names the flash', r.reasonCode, 'frozen_flash');
  assert('no live violation is claimed', r.priceVisible, false);
  assert('the flash note carries the glimpse', r.flashNote.includes('۲۵۸,۱۱۸'), true);
  assert('describes the freeze honestly', r.description.includes('از پاسخ‌دادن بازایستاد'), true);
}

// The adapter moved to the browser path for exactly this reason.
assert('wallex no longer reads the served document statically', typeof wallex.fetchProbe, 'undefined');
assert('wallex probes in the browser', typeof wallex.probeInPage, 'function');
assert('wallex declares its locking main thread', wallex.frozenThread, true);

// The __NEXT_DATA__ cross-check reads the authoritative price.
{
  const parsed = wallex.api.parse(wxHtml({ headline: '258,118' }));
  assert('api price parses', Math.round(parsed.price), 258118);
  assert('api is tomans', parsed.unitScale, 1);
}

console.log('\n=== eterex: a disabled tether page is compliance, not a fault ===');
{
  // اتراکس switches its USDT page off; the scraper stamps pageDisabled on a 5xx
  // and skips the fallback, and the verdict is compliance.
  const r = buildReport({
    scrape: {
      exchangeId: 'eterex', navError: null, httpStatus: 503, pageDisabled: true,
      ready: false, feedLive: false, probes: {}, flashed: { detected: false },
    },
    api: null, expect: 'hidden', unitLabel: 'تومان',
  });
  console.log('  ' + r.title);
  assert('5xx on a disabled page is compliant', r.state, 'compliant');
  assert('reason names the disabled page', r.reasonCode, 'page_disabled');
  assert('says the page is switched off', r.description.includes('غیرفعال'), true);
  assert('the status rides in the description, no duplicated detail', r.detail == null, true);
}
{
  // Without the adapter flag a 5xx stays «نامشخص» — the finding is per-adapter.
  const r = buildReport({
    scrape: {
      exchangeId: 'x', navError: null, httpStatus: 503,
      ready: false, feedLive: false, probes: {}, flashed: { detected: false },
    },
    api: null, expect: 'hidden', unitLabel: 'تومان',
  });
  assert('plain 5xx without the flag is still unknown', r.state, 'unknown');
}

console.log('\n=== tabdeal: only the CURRENT price counts ===');
const tdApi = { ok: true, price: 265410, change: 2.73, error: null };
const tdScrape = (probes) => ({
  exchangeId: 'tabdeal', ready: true, feedLive: true, durationMs: 11000,
  probes, flashed: { detected: false },
});
const tdProbes = (o) => Object.fromEntries(
  Object.entries(o).map(([k, raw], i) => [k, { label: k, raw, primary: i === 0, visible: true }])
);

// Current price disclosed -> violation.
{
  const r = buildReport({
    scrape: tdScrape(tdProbes({ headline: '265,460', approx: '265,460', lastTrade: '265,460', seoText: '265,460' })),
    api: tdApi, expect: 'hidden', unitLabel: 'تومان',
  });
  assert('current price -> violation', r.state, 'violation');
  assert('price', r.price.formatted, '۲۶۵,۴۶۰');
  assert('unit is tomans', r.price.unit, 'تومان');
}

// Only the 24h high/low remain -> NOT a violation; they are day-range stats.
// Probes carry the extracted value, or null when nothing was found — which is
// what the adapter produces. It never passes raw prose through, so a blanked
// "1 USDT = -- IRT" yields null rather than being read as the number 1.
{
  const r = buildReport({
    scrape: tdScrape(tdProbes({ headline: null, approx: null, lastTrade: null, seoText: null })),
    api: tdApi, expect: 'hidden', unitLabel: 'تومان',
  });
  assert('24h stats alone are not a breach', r.state, 'compliant');
}

// The page never finished hydrating -> unknown, not compliant.
{
  const r = buildReport({
    scrape: { exchangeId: 'tabdeal', ready: false, feedLive: false, durationMs: 400, probes: {} },
    api: null, expect: 'hidden', unitLabel: 'تومان',
  });
  assert('not ready -> unknown', r.state, 'unknown');
}

console.log('\n=== saraf: a display:none price is not displayed ===');
const sxf = (probes) => ({
  exchangeId: 'saraf', ready: true, feedLive: true, durationMs: 6000,
  probes, flashed: { detected: false },
});
const sxProbes = (o) => Object.fromEntries(
  Object.entries(o).map(([k, raw], idx) => [k, { label: k, raw, primary: idx === 0, visible: false, reason: 'not-rendered' }])
);

// The number is delivered in the HTML but the block is display:none.
{
  const r = buildReport({
    scrape: sxf(sxProbes({ headline: '266,025', latest: '266,025' })),
    api: null, expect: 'hidden', unitLabel: 'تومان',
  });
  console.log('  ' + r.description);
  assert('hidden block is compliant', r.state, 'compliant');
  assert('price not visible', r.priceVisible, false);
  assert('note explains display:none', r.description.includes('display:none'), true);
}

// Once the block is actually rendered, the same value IS a breach.
{
  const probes = Object.fromEntries(
    Object.entries({ headline: '266,025', latest: '266,025' })
      .map(([k, raw], idx) => [k, { label: k, raw, primary: idx === 0, visible: true, reason: 'visible' }])
  );
  const r = buildReport({
    scrape: sxf(probes), api: null, expect: 'hidden', unitLabel: 'تومان',
  });
  assert('rendered price is a violation', r.state, 'violation');
}

console.log('\n=== tetherland: a plainly shown price is a violation ===');
const tlApi = { ok: true, price: 268350, change: 3.03, error: null };
const tlf = (probes, ready = true) => ({
  exchangeId: 'tetherland', ready, feedLive: ready, durationMs: 9000,
  probes, flashed: { detected: false },
});
const tlProbe = (raw, over = {}) => ({
  priceSlot: { label: 'قیمت تتر در بالای صفحه', raw, primary: true, visible: true, reason: 'visible', ...over },
});

// The live shape: 268,350 تومان, server-rendered and plainly readable.
{
  const r = buildReport({ scrape: tlf(tlProbe('268,350')), api: tlApi, expect: 'hidden', unitLabel: 'تومان' });
  console.log('  ' + r.description);
  assert('shown price -> violation', r.state, 'violation');
  assert('price', r.price.formatted, '۲۶۸,۳۵۰');
  assert('unit is tomans', r.price.unit, 'تومان');
  assert('priceVisible', r.priceVisible, true);
}

// Same page, price slot blanked -> compliant.
{
  const r = buildReport({ scrape: tlf(tlProbe('--')), api: tlApi, expect: 'hidden', unitLabel: 'تومان' });
  assert('blanked slot -> compliant', r.state, 'compliant');
  assert('explains the placeholder', r.description.includes('خط تیره'), true);
}

// The price is still published anonymously, so the report has to say so.
{
  const r = buildReport({ scrape: tlf(tlProbe(null)), api: tlApi, expect: 'hidden', unitLabel: 'تومان' });
  assert('notes the public API still serves it', r.description.includes('API عمومی'), true);
}

// The page never finished loading -> unknown, never a silent pass.
{
  const r = buildReport({ scrape: tlf({}, false), api: null, expect: 'hidden', unitLabel: 'تومان' });
  assert('not ready -> unknown', r.state, 'unknown');
}

// The anonymous endpoint returns the 24h high and low beside the spot price,
// and all three sit in the same object.
{
  const parsed = require('../src/exchanges/tetherland').api.parse(JSON.stringify({
    price: 268350, sell_price: 268350, buy_price: 268350,
    diff24d: '3.03', last24hMin: 260450, last24hMax: 268800,
  }));
  assert('api takes the spot price', parsed.price, 268350);
  assert('api ignores the 24h range', parsed.price >= 268800, false);
  assert('api is tomans', parsed.unitScale, 1);
}

console.log('\n=== sarmayex: one price in three places, all violations ===');
const sxApi = { ok: true, price: 268993, change: 2.822, error: null };
const smxf = (probes, ready = true) => ({
  exchangeId: 'sarmayex', ready, feedLive: ready, durationMs: 11000,
  probes, flashed: { detected: false },
});
const smxEntry = (raw, over = {}) => ({
  label: 'ردیف تتر در جدول بازار', raw, primary: true, visible: true, reason: 'visible', ...over,
});

// The live digit formats differ by location, and both must produce one verdict.
{
  const probes = {
    tape: { label: 'نوار قیمت‌های لحظه‌ای', raw: '267,433', visible: true, reason: 'visible' },
    table: smxEntry('۲۶۷٬۴۳۳'),
    card: { label: 'کارت تتر در بخش شکار سود', raw: '۲۶۷٬۴۳۳', visible: true, reason: 'visible' },
  };
  const r = buildReport({ scrape: smxf(probes), api: sxApi, expect: 'hidden', unitLabel: 'تومان' });
  console.log('  ' + r.description);
  assert('latin and persian digits agree on one verdict', r.state, 'violation');
  // The ticker is listed first because it is the only probe guaranteed to be in
  // the viewport, so it decides which value the report quotes.
  assert('first visible probe wins the reported value', r.price.formatted, '۲۶۷,۴۳۳');
  assert('value is correct', r.price.value, 267433);
  assert('unit is tomans', r.price.unit, 'تومان');
}

// Even with two sites blanked, the third still discloses it.
{
  const r = buildReport({
    scrape: smxf({ tape: { label: 'نوار قیمت‌های لحظه‌ای', raw: null, visible: true }, table: smxEntry('۲۶۷٬۴۳۳') }),
    api: sxApi, expect: 'hidden', unitLabel: 'تومان',
  });
  assert('one surviving site is enough', r.state, 'violation');
}

// All three blanked -> compliant.
{
  const probes = {
    tape: { label: 'نوار قیمت‌های لحظه‌ای', raw: null, visible: true },
    table: smxEntry(null),
    card: { label: 'کارت تتر در بخش شکار سود', raw: null, visible: true },
  };
  const r = buildReport({ scrape: smxf(probes), api: sxApi, expect: 'hidden', unitLabel: 'تومان' });
  assert('all three blanked -> compliant', r.state, 'compliant');
  assert('notes the public API still serves it', r.description.includes('API عمومی'), true);
}

// Not ready -> unknown, never a silent pass.
{
  const r = buildReport({ scrape: smxf({}, false), api: null, expect: 'hidden', unitLabel: 'تومان' });
  assert('not ready -> unknown', r.state, 'unknown');
}

// The API is a flat map of 31 pairs; only USDT_IRT is the tether market, and the
// 24h high/low/quote-volume sit in the very same object.
{
  const sarmayex = require('../src/exchanges/sarmayex');
  const parsed = sarmayex.api.parse(JSON.stringify({
    data: {
      USDT_IRT: {
        price: '268993', ticker_last: '268993', change_percent: '2.822',
        ticker_high: '269000', ticker_low: '259334', ticker_quote_volume: '12173400064',
      },
      BTC_IRT: { price: '84710.11' },
      BTC_USDT: { price: '84857.88' },
    },
  }));
  assert('api takes the USDT_IRT price', parsed.price, 268993);
  assert('api ignores the 24h high', parsed.price === 269000, false);
  assert('api ignores the quote volume', parsed.price === 12173400064, false);
  assert('api change', parsed.change, 2.822);
  assert('api is tomans', parsed.unitScale, 1);
  assert('api is null without the pair', sarmayex.api.parse(JSON.stringify({ data: { BTC_IRT: {} } })), null);
}

console.log('\n=== hamtapay: two locations, same price, same verdict ===');
const hpApi = { ok: true, price: 268696, change: 2.83, error: null };
const hpf = (probes, ready = true) => ({
  exchangeId: 'hamtapay', ready, feedLive: ready, durationMs: 11000,
  probes, flashed: { detected: false },
});

// Persian digits with a LATIN comma, exactly as the live site renders them.
{
  const probes = {
    header: { label: 'قیمت تتر در بالای صفحه', raw: '۲۶۸,۹۱۳', primary: true, visible: true, reason: 'visible' },
    strip: { label: 'قیمت تتر در فهرست ارزهای دیگر', raw: '۲۶۸,۹۱۳', visible: true, reason: 'visible' },
  };
  const r = buildReport({ scrape: hpf(probes), api: hpApi, expect: 'hidden', unitLabel: 'تومان' });
  console.log('  ' + r.description);
  assert('shown price -> violation', r.state, 'violation');
  assert('persian digits with a latin comma', r.price.value, 268913);
  assert('unit is tomans', r.price.unit, 'تومان');
}

// One surviving location is enough.
{
  const r = buildReport({
    scrape: hpf({ header: { label: 'قیمت تتر در بالای صفحه', raw: '۲۶۸,۹۱۳', primary: true, visible: true } }),
    api: hpApi, expect: 'hidden', unitLabel: 'تومان',
  });
  assert('header alone is a violation', r.state, 'violation');
}

// The strip renders late. Its absence must not turn into نامشخص — the page is
// clearly loaded and clearly shows the price.
{
  const probes = {
    header: { label: 'قیمت تتر در بالای صفحه', raw: '۲۶۸,۹۱۳', primary: true, visible: true },
    strip: { label: 'قیمت تتر در فهرست ارزهای دیگر', raw: null, visible: true },
  };
  const r = buildReport({ scrape: hpf(probes), api: hpApi, expect: 'hidden', unitLabel: 'تومان' });
  assert('a missing strip is still a violation', r.state, 'violation');
}

// Everything blanked -> compliant, and the API note still fires.
{
  const probes = {
    header: { label: 'قیمت تتر در بالای صفحه', raw: null, primary: true, visible: true },
    strip: { label: 'قیمت تتر در فهرست ارزهای دیگر', raw: null, visible: true },
  };
  const r = buildReport({ scrape: hpf(probes), api: hpApi, expect: 'hidden', unitLabel: 'تومان' });
  assert('both blanked -> compliant', r.state, 'compliant');
  assert('notes the public API still serves it', r.description.includes('API عمومی'), true);
}

// Not ready -> unknown, never a silent pass.
{
  const r = buildReport({ scrape: hpf({}, false), api: null, expect: 'hidden', unitLabel: 'تومان' });
  assert('not ready -> unknown', r.state, 'unknown');
}

// The peg and the market cap are the two decoys the page-level probe rules out;
// here the API object carries its own version of the same trap.
{
  const hamtapay = require('../src/exchanges/hamtapay');
  const parsed = hamtapay.api.parse(JSON.stringify({
    data: {
      'USDT-IRT': {
        sell: '267994.749491180461286048724875',
        buy: '270682.761020680766815497558625',
        market_price: 268696,
        change_rate_24h: 2.83,
        max_price_24h: 269120,
        avg: '269338.75525593061405077314',
      },
      'BTC-IRT': { market_price: 85000 },
    },
  }));
  assert('api takes market_price', parsed.price, 268696);
  assert('api ignores sell and buy', parsed.price === 267994.74949118046, false);
  assert('api ignores the rolling avg', parsed.price === 269338.7552559306, false);
  assert('api ignores the 24h high', parsed.price === 269120, false);
  assert('api change', parsed.change, 2.83);
  assert('api is tomans', parsed.unitScale, 1);
  assert('api is null without the pair', hamtapay.api.parse(JSON.stringify({ data: { 'BTC-IRT': {} } })), null);
}

console.log('\n=== arzinja: five locations for one price ===');
const azf = (probes, ready = true) => ({
  exchangeId: 'arzinja', ready, feedLive: ready, durationMs: 11000,
  probes, flashed: { detected: false },
});
const azProbes = (over = {}) => ({
  hero: { label: 'قیمت تتر امروز', raw: '۲۶۸,۵۰۵', primary: true, visible: true, reason: 'visible' },
  card: { label: 'قیمت لحظه ای تتر', raw: '۲۶۸,۵۰۵', visible: true, reason: 'visible' },
  ticker: { label: 'نرخ تبدیل در معامله آنی', raw: '۲۶۸,۵۰۵', visible: true, reason: 'visible' },
  sidebar: { label: 'آخرین قیمت تتر به تومان', raw: '۲۶۸,۵۰۵', visible: true, reason: 'visible' },
  marketTable: { label: 'قیمت تتر در جدول بازار', raw: '۲۶۸,۷۵۰', visible: true, reason: 'visible' },
  ...over,
});

{
  const r = buildReport({ scrape: azf(azProbes()), api: null, expect: 'hidden', unitLabel: 'تومان' });
  console.log('  ' + r.description);
  assert('shown price -> violation', r.state, 'violation');
  assert('price', r.price.value, 268505);
  assert('unit is tomans', r.price.unit, 'تومان');
  // api is null by decision, so the report must not imply a cross-check exists.
  assert('no API claim when there is no API', r.description.includes('API عمومی'), false);
}

// Four sites gone, the market table left: still a violation.
{
  const probes = azProbes({ hero: { label: 'قیمت تتر امروز', raw: null, primary: true, visible: true }, card: { label: 'قیمت لحظه ای تتر', raw: null, visible: true }, ticker: { label: 'نرخ تبدیل در معامله آنی', raw: null, visible: true }, sidebar: { label: 'آخرین قیمت تتر به تومان', raw: null, visible: true } });
  const r = buildReport({ scrape: azf(probes), api: null, expect: 'hidden', unitLabel: 'تومان' });
  assert('the market table alone is a violation', r.state, 'violation');
  assert('and it reports its own value', r.price.value, 268750);
}

// All five blanked -> compliant, with no API note to fall back on.
{
  const blank = { hero: null, card: null, ticker: null, sidebar: null, marketTable: null };
  const probes = azProbes(Object.fromEntries(Object.entries(blank).map(([k, v]) => [k, { label: k, raw: v, visible: true }])));
  const r = buildReport({ scrape: azf(probes), api: null, expect: 'hidden', unitLabel: 'تومان' });
  assert('all five blanked -> compliant', r.state, 'compliant');
  assert('still no API claim', r.description.includes('API عمومی'), false);
}

// Not ready -> unknown, never a silent pass.
{
  const r = buildReport({ scrape: azf({}, false), api: null, expect: 'hidden', unitLabel: 'تومان' });
  assert('not ready -> unknown', r.state, 'unknown');
}

// The adapter has no API on purpose — guard that decision from being undone
// by a well-meaning "improvement".
assert('arzinja deliberately has no API adapter', require('../src/exchanges/arzinja').api, null);

console.log('\n=== iranexchange: one rate in two digit formats ===');
const ieApi = null;
const ief = (probes, ready = true) => ({
  exchangeId: 'iranexchange', ready, feedLive: ready, durationMs: 11000,
  probes, flashed: { detected: false },
});

// The live shape of the page: the table does not list tether, and the widget
// alone discloses the rate. Both digit formats must classify identically.
{
  const r = buildReport({
    scrape: ief({
      widget: { label: 'نرخ تبدیل تتر در صفحه خرید', raw: '۲۶۸٬۷۵۰', primary: true, visible: true, reason: 'visible' },
      table: { label: 'قیمت خرید تتر در جدول بازار', raw: null, visible: true, reason: 'visible' },
    }),
    api: ieApi, expect: 'hidden', unitLabel: 'تومان',
  });
  console.log('  ' + r.description);
  assert('the widget alone is a violation', r.state, 'violation');
  // Persian digits with U+066C — the separator the other sites never use.
  assert('U+066C parses correctly', r.price.value, 268750);
  assert('unit is tomans', r.price.unit, 'تومان');
  assert('no API claim', r.description.includes('API عمومی'), false);
}

// When the table does list tether, it uses the OTHER digit format, and the two
// surfaces legitimately disagree on the number.
{
  const r = buildReport({
    scrape: ief({
      widget: { label: 'نرخ تبدیل تتر در صفحه خرید', raw: '۲۶۸٬۷۵۰', primary: true, visible: true, reason: 'visible' },
      table: { label: 'قیمت خرید تتر در جدول بازار', raw: '268,800', visible: true, reason: 'visible' },
    }),
    api: ieApi, expect: 'hidden', unitLabel: 'تومان',
  });
  assert('both surfaces -> violation', r.state, 'violation');
  assert('the first visible probe decides the quoted value', r.price.value, 268750);
}

// Latin digits with an ASCII comma, as the table renders them.
{
  const r = buildReport({
    scrape: ief({
      widget: { label: 'نرخ تبدیل تتر در صفحه خرید', raw: null, primary: true, visible: true },
      table: { label: 'قیمت خرید تتر در جدول بازار', raw: '268,800', visible: true, reason: 'visible' },
    }),
    api: ieApi, expect: 'hidden', unitLabel: 'تومان',
  });
  assert('a latin-digit table price is a violation', r.state, 'violation');
  assert('latin digits give the right value', r.price.value, 268800);
}

// Everything blanked -> compliant.
{
  const r = buildReport({
    scrape: ief({
      widget: { label: 'نرخ تبدیل تتر در صفحه خرید', raw: null, primary: true, visible: true },
      table: { label: 'قیمت خرید تتر در جدول بازار', raw: null, visible: true },
    }),
    api: ieApi, expect: 'hidden', unitLabel: 'تومان',
  });
  assert('both blanked -> compliant', r.state, 'compliant');
}

// Not ready -> unknown, never a silent pass.
{
  const r = buildReport({ scrape: ief({}, false), api: ieApi, expect: 'hidden', unitLabel: 'تومان' });
  assert('not ready -> unknown', r.state, 'unknown');
}

// Third adapter with no API, by decision.
assert('iranexchange deliberately has no API adapter', require('../src/exchanges/iranexchange').api, null);

console.log('\n=== asretether: two copies, one of them always visible ===');
const atf = (probes, ready = true) => ({
  exchangeId: 'asretether', ready, feedLive: ready, durationMs: 11000,
  probes, flashed: { detected: false },
});
const atCopy = (key, raw, over = {}) => ({
  [key]: { label: 'قیمت تتر به تومان', raw, visible: true, reason: 'visible', ...over },
});

// The live shape at 1440px: copy 1 hidden, copy 2 on screen.
{
  const probes = Object.assign(
    atCopy('card1', '268,001', { label: 'قیمت تتر به تومان (نسخه موبایل)', visible: false, reason: 'not-rendered' }),
    atCopy('card2', '268,001', { primary: true })
  );
  const r = buildReport({ scrape: atf(probes), api: null, expect: 'hidden', unitLabel: 'تومان' });
  console.log('  ' + r.description);
  assert('the visible copy is a violation', r.state, 'violation');
  assert('price', r.price.value, 268001);
  assert('unit is tomans', r.price.unit, 'تومان');
  assert('no API claim', r.description.includes('API عمومی'), false);
  // On the violation path diagnose returns early, so the hidden duplicate
  // produces no note. It only surfaces when the page would otherwise be
  // compliant — which is the next case.
  assert('no hidden-duplicate note on the violation path', r.description.includes('نمایش داده نمی‌شود'), false);
}

// The case the "probe both" design actually earns its keep on: the only
// surviving price sits in the hidden responsive copy, so the page reads as
// compliant — but the value really is there, and the report must say so rather
// than quietly dropping it.
{
  const probes = Object.assign(
    atCopy('card1', '268,001', { visible: false, reason: 'not-rendered' }),
    atCopy('card2', null)
  );
  const r = buildReport({ scrape: atf(probes), api: null, expect: 'hidden', unitLabel: 'تومان' });
  console.log('  ' + r.description);
  assert('no visible price -> compliant', r.state, 'compliant');
  assert('the hidden duplicate is still reported', r.description.includes('نمایش داده نمی‌شود'), true);
}

// Both copies blanked -> compliant, and still no API fallback to lean on.
{
  const probes = Object.assign(
    atCopy('card1', null, { visible: false, reason: 'not-rendered' }),
    atCopy('card2', null)
  );
  const r = buildReport({ scrape: atf(probes), api: null, expect: 'hidden', unitLabel: 'تومان' });
  assert('both copies blanked -> compliant', r.state, 'compliant');
  assert('still no API claim', r.description.includes('API عمومی'), false);
}

// Only the mobile copy visible (the 900px layout) is equally a violation —
// which is the point of probing both instead of guessing the breakpoint.
{
  const probes = Object.assign(atCopy('card1', '268,001'), atCopy('card2', null, { visible: false, reason: 'not-rendered' }));
  const r = buildReport({ scrape: atf(probes), api: null, expect: 'hidden', unitLabel: 'تومان' });
  assert('the mobile copy alone is a violation', r.state, 'violation');
  assert('and reports the same value', r.price.value, 268001);
}

// Not ready -> unknown, never a silent pass.
{
  const r = buildReport({ scrape: atf({}, false), api: null, expect: 'hidden', unitLabel: 'تومان' });
  assert('not ready -> unknown', r.state, 'unknown');
}

// Fourth adapter with no API, by decision.
assert('asretether deliberately has no API adapter', require('../src/exchanges/asretether').api, null);

console.log('\n=== hitobit: one span, filled by the page’s own script ===');
const hbf = (raw, ready = true) => ({
  exchangeId: 'hitobit', ready, feedLive: ready, durationMs: 11000,
  probes: { priceSlot: { label: 'قیمت بازار: تتر', raw, primary: true, visible: true, reason: 'visible' } },
  flashed: { detected: false },
});

// Filled -> violation.
{
  const r = buildReport({ scrape: hbf('269,033'), api: null, expect: 'hidden', unitLabel: 'تومان' });
  console.log('  ' + r.description);
  assert('a shown price is a violation', r.state, 'violation');
  assert('price', r.price.value, 269033);
  assert('unit is tomans', r.price.unit, 'تومان');
  assert('no API claim', r.description.includes('API عمومی'), false);
}

// The en-dash the span holds until the page's own script fills it. It must be
// called a placeholder, and specifically NOT a missing location — the slot is
// right there, it simply has no number yet.
{
  const r = buildReport({ scrape: hbf('–'), api: null, expect: 'hidden', unitLabel: 'تومان' });
  console.log('  ' + r.description);
  assert('the en-dash placeholder is compliant', r.state, 'compliant');
  assert('...explained as a placeholder', r.description.includes('خط تیره'), true);
  assert('...not as a missing location', r.description.includes('پیدا نشد'), false);
}

// A genuinely absent slot is unknown, not compliant.
{
  const r = buildReport({ scrape: hbf(null, false), api: null, expect: 'hidden', unitLabel: 'تومان' });
  assert('not ready -> unknown', r.state, 'unknown');
}

// Fifth adapter with no API, by decision.
assert('hitobit deliberately has no API adapter', require('../src/exchanges/hitobit').api, null);

console.log('\n=== eterex: four locations, two digit systems ===');
const etf = (probes, ready = true) => ({
  exchangeId: 'eterex', ready, feedLive: ready, durationMs: 11000,
  probes, flashed: { detected: false },
});
const etProbes = (over = {}) => ({
  hero: { label: 'قیمت تتر در بنر اصلی', raw: '268,400', primary: true, visible: true, reason: 'visible' },
  input: { label: 'مبلغ پیش‌فرض خرید', raw: '268,400', visible: true, reason: 'visible' },
  rate: { label: 'نرخ تبدیل', raw: '۲۶۸٬۴۰۰', visible: true, reason: 'visible' },
  stat: { label: 'قیمت تومانی', raw: '۲۶۸٬۴۰۰', visible: true, reason: 'visible' },
  ...over,
});

{
  const r = buildReport({ scrape: etf(etProbes()), api: null, expect: 'hidden', unitLabel: 'تومان' });
  console.log('  ' + r.description);
  assert('shown price is a violation', r.state, 'violation');
  assert('price value', r.price.value, 268400);
  assert('unit is tomans', r.price.unit, 'تومان');
  assert('no API claim', r.description.includes('API عمومی'), false);
}

// ONE location disclosing is enough. The Persian-digit locations must be
// judged identically to the Latin ones.
{
  const probes = etProbes({
    hero: { label: 'قیمت تتر در بنر اصلی', raw: null, primary: true, visible: true },
    input: { label: 'مبلغ پیش‌فرض خرید', raw: null, visible: true },
    rate: { label: 'نرخ تبدیل', raw: null, visible: true },
  });
  const r = buildReport({ scrape: etf(probes), api: null, expect: 'hidden', unitLabel: 'تومان' });
  assert('the Persian-digit stat alone is a violation', r.state, 'violation');
  assert('U+066C parses to the same number', r.price.value, 268400);
}

// All four blanked -> compliant.
{
  const probes = etProbes({
    hero: { label: 'x', raw: null, primary: true, visible: true },
    input: { label: 'x', raw: null, visible: true },
    rate: { label: 'x', raw: null, visible: true },
    stat: { label: 'x', raw: null, visible: true },
  });
  const r = buildReport({ scrape: etf(probes), api: null, expect: 'hidden', unitLabel: 'تومان' });
  assert('all four blanked -> compliant', r.state, 'compliant');
}

// Not ready -> unknown, never a silent pass.
{
  const r = buildReport({ scrape: etf({}, false), api: null, expect: 'hidden', unitLabel: 'تومان' });
  assert('not ready -> unknown', r.state, 'unknown');
}

// Sixth adapter with no API, by decision.
assert('eterex deliberately has no API adapter', require('../src/exchanges/eterex').api, null);

/* ---------- per-exchange statistics ---------- */

console.log('\n=== store: per-exchange statistics ===');
const store = require('../src/store');
const fake = (state, price, id) => ({
  checkedAt: new Date(Date.now() + store.overall().totalChecks * 1000).toISOString(),
  exchangeId: id || 'bitpin',
  state,
  priceVisible: state === 'violation',
  price: price ? { value: price, formatted: String(price) } : null,
  change: null,
  durationMs: 100,
});

store.add(fake('compliant'));
store.add(fake('compliant'));
const bs = store.store('bitpin').stats();
assert('compliant counted', bs.compliantChecks, 2);
assert('rate 100%', bs.compliancePercent, 100);
assert('last violation null', bs.lastViolationAt, null);

store.add(fake('unknown'));
assert('unknown not a pass', store.store('bitpin').stats().compliancePercent, 100);
assert('unknown tracked', store.store('bitpin').stats().unknownChecks, 1);

store.add(fake('violation', 261500));
store.add(fake('violation', 262000));
let st = store.store('bitpin').stats();
assert('violations counted', st.violationChecks, 2);
assert('violation streak', st.consecutiveViolations, 2);
assert('rate 50%', st.compliancePercent, 50);
assert('last violation price', st.lastViolationPrice, 262000);

store.add(fake('compliant', null, 'nobitex'));
let overall = store.overall();
assert('twenty exchanges', overall.exchangeCount, 20);
assert('overall violation', overall.state, 'violation');
assert('total violations summed', overall.totalViolations, 2);
assert('bitpin rate unchanged by other exchange', store.store('bitpin').stats().compliancePercent, 50);
assert('nobitex rate', store.store('nobitex').stats().compliancePercent, 100);

store.add(fake('compliant'));
assert('overall recovers to compliant', store.overall().state, 'compliant');
assert('last violation kept', store.overall().lastViolationAt !== null, true);

console.log('\n=== overall: the headline rate counts exchanges, not checks ===');
// Fresh store, so nothing above can leak into these assertions.
const Store2 = require('../src/store').constructor;
const fresh = new Store2();
let tick = 0;
const mk = (state, price, id) => ({
  checkedAt: new Date(Date.now() + (tick += 1000)).toISOString(),
  exchangeId: id, state,
  priceVisible: state === 'violation',
  price: price ? { value: price, formatted: String(price) } : null,
  change: null, durationMs: 100,
});

// Bitpin has run 9 checks (7 compliant, 2 violating) — a long history. Nobitex
// has run exactly one. If the headline rate still summed lifetime CHECK
// counters, bitpin's nine runs would dominate the figure; counting exchanges,
// each contributes one vote.
for (let i = 0; i < 7; i += 1) fresh.add(mk('compliant', null, 'bitpin'));
fresh.add(mk('violation', 260000, 'bitpin'));
fresh.add(mk('violation', 261000, 'bitpin'));
fresh.add(mk('compliant', null, 'nobitex'));

const o1 = fresh.overall();
assert('two exchanges decided', o1.decidedExchanges, 2);
assert('one exchange currently compliant', o1.compliantExchanges, 1);
assert('rate is 50% regardless of check history', o1.compliancePercent, 50);
assert('no undecided exchange yet', o1.unknownExchanges, 0);

// An undecided exchange drops out of the denominator rather than counting as a
// pass — and an exchange never checked at all is undecided too.
fresh.add(mk('unknown', null, 'ramzinex'));
const o2 = fresh.overall();
assert('unknown exchange tracked', o2.unknownExchanges, 1);
assert('undecided exchange excluded from the rate', o2.compliancePercent, 50);
assert('denominator is decided exchanges only', o2.decidedExchanges, 2);

// The lifetime check-based figure is preserved under a different name, so
// nothing that wanted the old meaning silently loses it. Here: 8 compliant
// checks out of 10 decided.
assert('check-based ratio kept as checkCompliancePercent', o2.checkCompliancePercent, 80);

// An exchange never checked at all is also undecided.
fresh.add(mk('violation', 262000, 'tabdeal'));
const o3 = fresh.overall();
assert('third decided exchange counted', o3.decidedExchanges, 3);
assert('rate recomputes to 1 of 3', Math.round(o3.compliancePercent), 33);
assert('exchangeCount still counts every adapter', o3.exchangeCount, 20);

console.log('\n=== log: the execution ring buffer ===');
const logMod = require('../src/log');
logMod.clear();
logMod.push('info', 'بررسی کامل شد', { exchangeId: 'bitpin', exchangeName: 'بیت‌پین', durationMs: 900 });
logMod.push('warn', 'سرور وضعیت ۵۰۳ برگرداند', { exchangeId: 'eterex', code: 'http_503', httpStatus: 503 });
logMod.push('error', 'صفحه باز نشد', { exchangeId: 'eterex', code: 'nav_error' });
logMod.push('info', 'بررسی کامل شد', { exchangeId: 'nobitex' });

{
  const all = logMod.recent({ limit: 100 });
  assert('newest first', all[0].message, 'بررسی کامل شد');
  assert('four entries buffered', all.length, 4);
  assert('lifetime error count', logMod.counts().error, 1);
  assert('lifetime warn count', logMod.counts().warn, 1);
  assert('filter by level keeps only that level', logMod.recent({ level: 'error' }).length, 1);
  assert('filter by exchange', logMod.recent({ exchangeId: 'eterex' }).length, 2);
  assert('httpStatus carried on the entry', logMod.recent({ level: 'warn' })[0].httpStatus, 503);
  assert('code carried on the entry', logMod.recent({ level: 'warn' })[0].code, 'http_503');
}

// The ring drops the OLDEST entries, and the lifetime counters survive the drop.
const before = logMod.counts().info;
for (let i = 0; i < 700; i += 1) logMod.push('info', `پرکردن حافظه ${i}`, { exchangeId: 'fill' });
{
  const all = logMod.recent({ limit: 1000 });
  assert('ring buffer capped', all.length, 600);
  // The loop pushes messages 0..699, so 699 is the newest.
  assert('oldest entries dropped, newest kept', all[0].message, 'پرکردن حافظه 699');
  assert('lifetime counters survive the drop', logMod.counts().info, before + 700);
}

// An unknown level is a programming error and should be loud, not silently miscategorised.
assert('unknown level throws', (() => { try { logMod.push('catastrophe', 'x'); return 'no-throw'; } catch { return 'threw'; } })(), 'threw');

console.log('\n=== log: debug metadata ===');
{
  // One check fans out to several pushes that share a meta object. If push() held the
  // reference, a per-call field would retroactively rewrite an entry already stored.
  const shared = { state: 'unknown', expect: 'hidden', probes: { headline: { raw: '۲۶۱,۷۳۲', visible: false, primary: true } } };
  logMod.clear();
  logMod.push('warn', 'اولی', { code: 'nav_error', meta: shared });
  shared.state = 'violation';
  logMod.push('info', 'دومی', { code: 'hidden', meta: shared });
  const [second, first] = logMod.recent({});
  assert('meta is stored as a copy, not the source object', first.meta.state, 'unknown');
  assert('a later push still sees its own meta', second.meta.state, 'violation');
  assert('nested probes survive', first.meta.probes.headline.raw, '۲۶۱,۷۳۲');

  // The ring holds 600 entries and never shrinks, so meta must be bounded or a single
  // fat value is a slow leak.
  const huge = logMod.sanitiseMeta({
    long: 'x'.repeat(5000),
    many: Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`k${i}`, i])),
    list: Array.from({ length: 50 }, (_, i) => i),
    gone: undefined,
    fn: () => {},
    nested: { a: { b: { c: { d: 'too deep' } } } },
    ok: 42,
    flag: false,
  });
  assert('long strings are capped', huge.long.length, 160);
  assert('capped string is marked', huge.long.endsWith('…'), true);
  assert('object keys are capped', Object.keys(huge.many).length, 40);
  assert('arrays are capped', huge.list.length, 20);
  assert('undefined is dropped', 'gone' in huge, false);
  assert('functions are dropped', 'fn' in huge, false);
  // Depth 3 is the cap: probes (depth 0) -> key (1) -> reading (2) still fits, and the
  // level below that is replaced by an ellipsis rather than recursed into.
  assert('recursion stops at the depth cap', huge.nested.a.b, '…');
  assert('nothing survives below the cap', huge.nested.a.b.c, undefined);
  assert('numbers pass through', huge.ok, 42);
  assert('false is kept, not treated as empty', huge.flag, false);
  assert('non-finite numbers become strings', logMod.sanitiseMeta({ n: Infinity }).n, 'Infinity');

  // "صفحه باز نشد" cannot tell these four apart on its own; the net::ERR_* token Playwright
  // already embedded can.
  assert(
    'DNS failure is classified',
    logMod.classifyNavError('page.goto: net::ERR_NAME_NOT_RESOLVED at https://bitpin.ir'),
    { netErr: 'net::ERR_NAME_NOT_RESOLVED', kind: 'dns' },
  );
  assert(
    'navigation timeout is classified',
    logMod.classifyNavError('page.goto: Timeout 60000ms exceeded.'),
    { netErr: null, kind: 'timeout' },
  );
  assert(
    'a refused connection is classified',
    logMod.classifyNavError('page.goto: net::ERR_CONNECTION_REFUSED'),
    { netErr: 'net::ERR_CONNECTION_REFUSED', kind: 'connection' },
  );
  assert(
    'being offline is its own category',
    logMod.classifyNavError('net::ERR_INTERNET_DISCONNECTED').kind,
    'offline',
  );
  assert(
    'a TLS failure is its own category',
    logMod.classifyNavError('net::ERR_CERT_AUTHORITY_INVALID').kind,
    'tls',
  );
  assert(
    'an unrecognised error is not guessed at',
    logMod.classifyNavError('fetch failed'),
    { netErr: null, kind: 'unknown' },
  );
  assert('empty input is safe', logMod.classifyNavError(undefined).kind, 'unknown');

  // The browser-free path has no net::ERR_ token — its only signal is Node's cause code.
  // Without this the static exchanges all reported the literal "fetch failed".
  assert(
    'a static-path DNS failure is classified from the cause code',
    logMod.classifyNavError('fetch failed', 'ENOTFOUND'),
    { netErr: null, kind: 'dns' },
  );
  assert(
    'a static-path connect timeout is classified',
    logMod.classifyNavError('fetch failed', 'UND_ERR_CONNECT_TIMEOUT').kind,
    'timeout',
  );
  assert(
    'a static-path refused connection is classified',
    logMod.classifyNavError('fetch failed', 'ECONNREFUSED').kind,
    'connection',
  );
  assert(
    'an unknown cause code stays unknown',
    logMod.classifyNavError('fetch failed', 'EWEIRD').kind,
    'unknown',
  );
  assert(
    'a net::ERR_ token still wins over a cause code',
    logMod.classifyNavError('net::ERR_NAME_NOT_RESOLVED', 'ETIMEDOUT').kind,
    'dns',
  );

  // `seq` is what lets the page keep a row expanded across its 10s poll.
  logMod.clear();
  const s1 = logMod.push('info', 'الف');
  const s2 = logMod.push('info', 'ب');
  assert('seq increases monotonically', s2.seq > s1.seq, true);
  assert('seq survives a filter', logMod.recent({ level: 'info' })[0].seq, s2.seq);
}

logMod.clear();
assert('clear empties the buffer', logMod.recent({}).length, 0);
assert('clear does not reset lifetime counts', logMod.counts().error > 0, true);

/* ---------- the readiness ceiling ---------- */

console.log('\n=== waiting for a surface is not the same wait as watching a price settle ===');

// `settleMs` exists to watch a price BLANK OUT. sampleOnce takes no reading until
// the probe reports ready, so on a page whose surface renders late every settle
// sample is a no-op and the whole window is wasted. Adapters declare
// `readyTimeoutMs` for that case; the ceiling only ever ADDS evidence before the
// judgement, and runs before the confirm phase so a surface that appears inside
// the budget is still tested for a late flash.
const { sampleUntilSettled } = require('../src/scraper');
const { probeVisibility } = require('../src/visibility');
const config = require('../src/config');

/**
 * A stub page whose probe reports ready from call `readyAt` on (-1 = never), with
 * a price on screen once it does. `visibility: false` makes the visibility check
 * throw, which is how the scraper's fail-closed path is exercised.
 */
function pageReadyAt(readyAt, { price = '۲۶۸,۰۸۰', visibility = true } = {}) {
  let probeCalls = 0;
  const page = {
    evaluate: async (fn) => {
      if (fn === probeVisibility) {
        if (!visibility) throw new Error('boom');
        return { row: { visible: true, reason: 'visible' } };
      }
      probeCalls += 1;
      const ready = readyAt >= 0 && probeCalls > readyAt;
      return {
        ready,
        feedLive: true,
        probes: [{ key: 'row', label: 'جدول بازار', raw: ready ? price : '', primary: true }],
        shots: [],
      };
    },
    // Real Playwright waits here, so the stub must too: the phases are budgets
    // in wall time and a no-op wait would spin them.
    waitForTimeout: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
  return { page, probeCalls: () => probeCalls };
}

const settleCfg = { settleMs: config.settleMs, sampleMs: config.sampleMs, confirmMs: config.confirmMs };
// Milliseconds rather than seconds: the phases are the same code either way, and
// the ceiling is a budget measured in wall time.
config.settleMs = 30;
config.sampleMs = 5;
config.confirmMs = 0;

const budgeted = (readyTimeoutMs) => ({ id: 'x', coin: 'USDT', readyTimeoutMs });

(async () => {
  // A surface that appears inside the budget is judged normally.
  {
    const { page, probeCalls } = pageReadyAt(3);
    const out = await sampleUntilSettled(page, budgeted(2_000), null);
    console.log(`  (${probeCalls()} probe calls)`);
    assert('the ceiling kept waiting until the surface appeared', out.sawReady, true);
    assert('...and the page is judged on it', out.finalAny, true);
    const rep = buildReport({
      scrape: { exchangeId: 'x', ready: out.sawReady, feedLive: out.feedLive, probes: { row: { label: 'جدول بازار', raw: '۲۶۸,۰۸۰', primary: true, visible: true, reason: 'visible' } }, flashed: out.flashed },
      api: null, expect: 'hidden', unitLabel: 'تومان',
    });
    console.log('  ' + rep.title);
    assert('a price on a late-rendered surface is a violation', rep.state, 'violation');
  }

  // A surface that never appears must stay «نامشخص». This is the direction that
  // matters: with no price visible anywhere, calling the page compliant would be
  // inventing a finding, and calling it a violation would be inventing another.
  {
    // What "the extra wait actually happened" means: strictly more probe calls
    // than an identical run with NO readiness ceiling. Counted against a fixed
    // number this check failed on a loaded machine, where every setTimeout(5)
    // costs more and each phase simply fits fewer iterations; against a control
    // run it holds whatever the machine is doing.
    const control = pageReadyAt(-1);
    await sampleUntilSettled(control.page, budgeted(0), null);
    const { page, probeCalls } = pageReadyAt(-1);
    const out = await sampleUntilSettled(page, budgeted(60), null);
    console.log(`  (${probeCalls()} probe calls, control ${control.probeCalls()})`);
    assert('the extra wait actually happened', probeCalls() > control.probeCalls(), true);
    assert('a surface that never renders is never ready', out.sawReady, false);
    assert('...and leaves no readings behind', out.readings.length, 0);
    // Without this the «نامشخص» detail is empty, which is what made the original
    // log entry impossible to investigate.
    assert('...but what the surfaces showed is still reported', out.observed.length, 1);
    assert('...including the empty read', out.observed[0].raw, '');
    const rep = buildReport({
      scrape: { exchangeId: 'x', ready: out.sawReady, feedLive: out.feedLive, probes: { row: { label: 'جدول بازار', raw: '', primary: true } }, flashed: out.flashed },
      api: { ok: true, price: 268080, change: 0, error: null }, expect: 'hidden', unitLabel: 'تومان',
    });
    console.log('  ' + rep.title);
    assert('never compliant on an unreadable page', rep.state, 'unknown');
    assert('...not a violation either', rep.priceVisible, false);
    assert('...the empty read rides in the probes', rep.probes.row.raw, '');
  }

  // The wait is bounded: a budget of 60ms cannot stretch into seconds.
  {
    const { page, probeCalls } = pageReadyAt(-1);
    const t0 = Date.now();
    await sampleUntilSettled(page, budgeted(60), null);
    assert('the ceiling is bounded, not open-ended', Date.now() - t0 < 3_000, true);
    assert('...and it stopped sampling at the deadline', probeCalls() < 100, true);
  }

  // A page that is ready from the first sample pays nothing: the extra wait is
  // conditional on the surface being MISSING, so a healthy cycle is unchanged.
  {
    const { page, probeCalls } = pageReadyAt(0);
    await sampleUntilSettled(page, budgeted(5_000), null);
    assert('a healthy page does not pay the ceiling', probeCalls() < 25, true);
  }

  // `readyTimeoutMs` is opt-in and defaults to 0, so the other nineteen adapters
  // cannot move: declaring none behaves exactly as it did before.
  {
    const { page: p1, probeCalls: noCeiling } = pageReadyAt(-1);
    await sampleUntilSettled(p1, { id: 'x', coin: 'USDT' }, null);
    const { page: p2, probeCalls: withCeiling } = pageReadyAt(-1);
    await sampleUntilSettled(p2, budgeted(60), null);
    assert('no declared ceiling means no extra waiting', noCeiling() < withCeiling(), true);
    assert('...and the ceiling is the only difference', noCeiling() > 1, true);
  }

  // Fail-closed inside the ceiling: a sample whose visibility check cannot be
  // completed is discarded, so a page we could not verify stays «نامشخص».
  {
    const { page } = pageReadyAt(0, { visibility: false });
    const out = await sampleUntilSettled(page, budgeted(40), null);
    assert('the probe did report ready', out.sawReady, true);
    assert('...but the unverifiable sample was discarded', out.readings.length, 0);
    assert('...and the reason is recorded', out.visibilityError.includes('boom'), true);
    const rep = buildReport({
      scrape: { exchangeId: 'x', ready: out.sawReady, feedLive: out.feedLive, visibilityError: out.visibilityError, probes: { row: { label: 'جدول بازار', raw: '۲۶۸,۰۸۰', primary: true } }, flashed: out.flashed },
      api: null, expect: 'hidden', unitLabel: 'تومان',
    });
    assert('unverifiable visibility is never compliant', rep.state, 'unknown');
    assert('...nor a violation', rep.priceVisible, false);
  }

  // A surface that appears inside the budget and then BLANKS is a late flash, not
  // a violation — the ceiling sits before the confirm phase precisely so this
  // still goes through it.
  {
    const { page } = pageReadyAt(3, { price: '۲۶۸,۰۸۰' });
    const out = await sampleUntilSettled(page, budgeted(2_000), null);
    assert('a late render is still judged', out.sawReady, true);
    assert('...and a persistent price is a violation', out.finalAny, true);
  }

  config.settleMs = settleCfg.settleMs;
  config.sampleMs = settleCfg.sampleMs;
  config.confirmMs = settleCfg.confirmMs;

  /* ---------- a page that wedges its own main thread ---------- */

  // Playwright's page.evaluate has no timeout of its own. رمزینکس begins a
  // client-side navigation about 3.5s into the load and, on roughly half of its
  // loads, never finishes it: the renderer stops answering forever at ~1% CPU.
  // Measured through the real scraper path, 4 of 5 consecutive checks burned the
  // entire checkTimeoutMs and were reported as `check_error`.
  console.log('\n--- a wedged page must not hang the check ---');
  {
    const evalCfg = { evaluateTimeoutMs: config.evaluateTimeoutMs, fillTimeoutMs: config.fillTimeoutMs, settleMs: config.settleMs, sampleMs: config.sampleMs };
    config.evaluateTimeoutMs = 40;
    config.fillTimeoutMs = 0;
    config.settleMs = 30;
    config.sampleMs = 20;

    // `never` models the wedge: every evaluate returns a promise that never
    // settles, exactly as the real one does.
    const wedged = {
      evaluate: () => new Promise(() => {}),
      waitForTimeout: (ms) => new Promise((r) => setTimeout(r, ms)),
    };
    const t0 = Date.now();
    const out = await sampleUntilSettled(wedged, { id: 'ramzinex', coin: 'USDT', readyTimeoutMs: 120 }, null);
    assert('the sampling loop gave up rather than hanging', Date.now() - t0 < 2_000, true);
    assert('...and read no price', out.finalAny, false);
    assert('...so nothing can be called a violation', out.sawReady, false);

    // And it lands on «نامشخص», which is retryable, not on `check_error`.
    const rep = buildReport({
      scrape: { exchangeId: 'ramzinex', ready: out.sawReady, feedLive: out.feedLive, probes: {}, flashed: out.flashed },
      api: null, expect: 'hidden', unitLabel: 'ریال',
    });
    assert('a wedged page is never compliant', rep.state, 'unknown');
    assert('...never a violation', rep.priceVisible, false);
    assert('...and stays retryable', rep.reasonCode, 'feed_stalled');

    config.evaluateTimeoutMs = evalCfg.evaluateTimeoutMs;
    config.fillTimeoutMs = evalCfg.fillTimeoutMs;
    config.settleMs = evalCfg.settleMs;
    config.sampleMs = evalCfg.sampleMs;
  }

  /* ---------- a surface that renders before it fills ---------- */

  // رمزینکس paints .market-overview with the headline slot at "0" and swaps in
  // the real number up to ~1.8s later. That state satisfies `ready`, so Phase 1b
  // (which only runs while not ready) and Phase 2 (which only runs once a price
  // has been seen) both fell through, and the check judged the half-filled page.
  console.log('\n--- a surface that renders before it fills must still be caught ---');
  {
    const fillCfg = { fillTimeoutMs: config.fillTimeoutMs, evaluateTimeoutMs: config.evaluateTimeoutMs, settleMs: config.settleMs, sampleMs: config.sampleMs };
    config.fillTimeoutMs = 400;
    config.evaluateTimeoutMs = 500;
    // Short enough that Phase 1 ends while the slot still reads 0 — which is the
    // whole premise of this block.
    config.settleMs = 30;
    config.sampleMs = 20;

    // Ready from the first sample; the headline reads 0 for the first three
    // samples and the real price afterwards.
    const filling = (() => {
      let calls = 0;
      const page = {
        evaluate: async (fn) => {
          if (fn === probeVisibility) return { row: { visible: true, reason: 'visible' } };
          calls += 1;
          return {
            ready: true,
            feedLive: true,
            probes: [{ key: 'row', label: 'قیمت تتر (بالای صفحه)', raw: calls <= 3 ? '0' : '2,678,500', primary: true }],
          };
        },
        waitForTimeout: (ms) => new Promise((r) => setTimeout(r, ms)),
      };
      return page;
    })();

    const out = await sampleUntilSettled(filling, { id: 'ramzinex', coin: 'USDT' }, null);
    assert('the fill window found the price', out.finalAny, true);
    const rep = buildReport({
      scrape: {
        exchangeId: 'ramzinex', ready: out.sawReady, feedLive: out.feedLive,
        probes: Object.fromEntries(out.final.probes.map((p) => [p.key, { label: p.label, raw: p.raw, primary: !!p.primary, visible: p.visible, reason: p.reason }])),
        flashed: out.flashed,
      },
      api: null, expect: 'hidden', unitLabel: 'ریال',
    });
    assert('a page caught mid-fill is a violation, not «رعایت شده»', rep.state, 'violation');
    assert('...with the price the probe read', rep.price.value, 2678500);

    // The window only ever ADDS evidence. With it off, the same page is judged
    // on its half-filled state — which is precisely the regression it fixes.
    config.fillTimeoutMs = 0;
    const calls = { n: 0 };
    const unfilled = {
      evaluate: async (fn) => {
        if (fn === probeVisibility) return { row: { visible: true, reason: 'visible' } };
        calls.n += 1;
        return {
          ready: true, feedLive: true,
          probes: [{ key: 'row', label: 'قیمت تتر (بالای صفحه)', raw: calls.n <= 3 ? '0' : '2,678,500', primary: true }],
        };
      },
      waitForTimeout: (ms) => new Promise((r) => setTimeout(r, ms)),
    };
    const out2 = await sampleUntilSettled(unfilled, { id: 'ramzinex', coin: 'USDT' }, null);
    assert('without the window the half-filled page is judged as-is', out2.finalAny, false);

    config.fillTimeoutMs = fillCfg.fillTimeoutMs;
    config.evaluateTimeoutMs = fillCfg.evaluateTimeoutMs;
    config.settleMs = fillCfg.settleMs;
    config.sampleMs = fillCfg.sampleMs;
  }

  /* ---------- the page title can never drive the verdict ---------- */

  console.log('\n--- the title is reported, never judged ---');
  {
    const titled = (title) => ({
      exchangeId: 'ramzinex', ready: true, feedLive: true, pageTitle: title,
      probes: {
        headline: { label: 'قیمت تتر (بالای صفحه)', raw: '0', primary: true, visible: true, reason: 'visible' },
      },
      flashed: { detected: false },
    });

    // The decisive assertion: a title carrying 2,678,500 with every in-page probe
    // blank. If the title could reach `visibleEntry`, this reads «تخلف».
    const r1 = buildReport({ scrape: titled('2,678,500 IRR | رمزینکس تریدر | تتر'), api: null, expect: 'hidden', unitLabel: 'ریال' });
    assert('a priced title does NOT make it a violation', r1.state, 'compliant');
    assert('...nor set priceVisible', r1.priceVisible, false);
    assert('...nor invent a price', r1.price, null);
    assert('but it IS reported', r1.titlePrice.value, 2678500);
    assert('...with the value formatted', r1.titlePrice.formatted, '۲,۶۷۸,۵۰۰');
    assert('...labelled as the title', r1.titlePrice.source, 'عنوان صفحه');
    assert('...in the page\'s own unit', r1.titlePrice.unit, 'ریال');
    assert('...and named in the description', r1.description.includes('سربرگ مرورگر'), true);

    // When the page itself shows the price, the verdict comes from the page and
    // the title is only the aside.
    const r2 = buildReport({
      scrape: {
        ...titled('2,678,500 IRR | رمزینکس تریدر | تتر'),
        probes: { headline: { label: 'قیمت تتر (بالای صفحه)', raw: '2,678,500', primary: true, visible: true, reason: 'visible' } },
      },
      api: null, expect: 'hidden', unitLabel: 'ریال',
    });
    assert('a priced page is a violation', r2.state, 'violation');
    assert('...sourced from the page, not the title', r2.price.source, 'قیمت تتر (بالای صفحه)');

    // An unreadable page still reports the title — that is exactly when it is
    // most worth naming.
    const r3 = buildReport({
      scrape: { exchangeId: 'ramzinex', ready: false, feedLive: false, pageTitle: '2,678,500 IRR | x', probes: {}, flashed: { detected: false } },
      api: null, expect: 'hidden', unitLabel: 'ریال',
    });
    assert('an unreadable page stays unknown', r3.state, 'unknown');
    assert('...while still reporting the title', r3.titlePrice.value, 2678500);

    // No number, no finding. And a title whose only number is not the price
    // (a volume, a market id) must not be read as one.
    assert('a title with no number yields nothing',
      buildReport({ scrape: titled('رمزینکس تریدر | تتر'), api: null, expect: 'hidden', unitLabel: 'ریال' }).titlePrice, null);
    assert('a zero-leading title is not a price',
      buildReport({ scrape: titled('0 | تتر | رمزینکس تریدر'), api: null, expect: 'hidden', unitLabel: 'ریال' }).titlePrice, null);
    assert('a missing title does not crash',
      buildReport({ scrape: { ...titled(null), pageTitle: null }, api: null, expect: 'hidden', unitLabel: 'ریال' }).titlePrice, null);

    // The scraper must never fold the title into the probe array, which is the
    // only thing `any` is computed from.
    const titledPage = {
      evaluate: async (fn) => {
        if (fn === probeVisibility) return { row: { visible: true, reason: 'visible' } };
        return {
          ready: true, feedLive: true, pageTitle: '2,678,500 IRR | x',
          probes: [{ key: 'row', label: 'قیمت تتر', raw: '0', primary: true }],
        };
      },
      waitForTimeout: (ms) => new Promise((r) => setTimeout(r, ms)),
    };
    const sampled = await sampleUntilSettled(titledPage, { id: 'ramzinex', coin: 'USDT' }, null);
    assert('the title rides up beside the scrape', sampled.pageTitle, '2,678,500 IRR | x');
    assert('...and never enters the readings', sampled.readings.some((r) => r.any), false);
    assert('...nor the probe list', sampled.final.probes.map((p) => p.key), ['row']);
  }

  const passed = checks.filter(Boolean).length;
  console.log(`\n${passed}/${checks.length} checks passed -> ${passed === checks.length ? 'PASS' : 'FAIL'}`);
  process.exit(passed === checks.length ? 0 : 1);
})();