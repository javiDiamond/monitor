'use strict';

/**
 * Browser-level test for the DOM probes, run against a local fixture rather
 * than the live site. Guards the parsing rules that have already caused real
 * bugs: value leaves carrying a unit suffix, prices buried in prose, decoy
 * numbers that must never be read, and the `data-probe` tags the shared
 * visibility check depends on.
 *
 *   node test/probe-dom.js
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { getBrowser, closeBrowser } = require('../src/scraper');

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

/** A tabdeal-shaped page including every decoy we have to ignore. */
function tabdealHtml(o = {}) {
  const v = {
    headline: '265,460', approx: '265,460', lastTrade: '265,460', seo: '265,460',
    dollar: '1', change: '+2.73% %', volume: '3,988,749.0734',
    high: '266,500', low: '254,000', hiddenGain: '+40.44% %',
    ...o,
  };
  return `<!doctype html><html lang="fa" dir="rtl"><body>
<div class="market-selection-card" style="visibility:hidden">
  <div>${v.hiddenGain}</div>
</div>

<div class="flex flex-col items-stretch w-full gap-1 rounded-lg p-4">
  <div class="flex justify-between items-center">
    <span>آخرین قیمت تتر</span><span> (به‌روزرسانی هر ۳۰ ثانیه) </span>
  </div>
  <div class="flex items-center gap-2 mt-2">
    <span>${v.dollar}</span><span>$</span>
  </div>
  <div class="flex flex-row-reverse items-center justify-between">
    <span dir="ltr">${v.change}</span>
    <div class="flex items-center gap-x-1">
      <span>${v.headline}</span><span> تومان </span>
    </div>
  </div>
</div>

<div class="w-full flex items-center justify-start my-6">
  <button type="button">swap</button>
  <div class="mr-2">
    <p>قیمت تقریبی</p>
    <p dir="ltr">1 USDT = ${v.approx} IRT</p>
  </div>
</div>

<div class="grid">
  <div><p>قیمت آخرین معامله</p><span dir="ltr">${v.lastTrade} تومان</span></div>
  <div><p>بالاترین قیمت ۲۴ ساعت گذشته</p><span dir="ltr">${v.high} تومان</span></div>
  <div><p>پایین‌ترین قیمت ۲۴ ساعت گذشته</p><span dir="ltr">${v.low} تومان</span></div>
  <div><p>حجم ۲۴ ساعته (تتر)</p><span dir="ltr">${v.volume} تتر</span></div>
</div>

<div class="market-chart">
  <svg><text x="10" y="20">258,000</text><text x="10" y="40">260,000</text>
  <text x="10" y="60">262,000</text><text x="10" y="80">264,000</text>
  <text x="10" y="100">266,000</text></svg>
</div>

<p class="seo">هم اکنون قیمت لحظه‌ای تتر ${v.seo} تومان، معادل 1 دلار آمریکا است.</p>
</body></html>`;
}

(async () => {
  // Two kinds of page on one port: the exchange-shaped fixture at `/`, and the
  // real dashboard at its OWN paths (`/exchange.html`, `/styles.css`, …).
  // Serving `public/` is what makes the CSS and page scripts testable at all —
  // nothing referenced them before, which is how four empty boxes and a missing
  // HTTP status shipped unnoticed. Served under the real paths rather than a
  // prefix so the absolute `/styles.css` in each page's <head> resolves, which
  // is the whole point: a stylesheet that 404s would make every `hidden`
  // assertion below pass vacuously.
  const publicDir = path.join(__dirname, '..', 'public');
  const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
  };
  const PUBLIC_FILES = new Set([
    'index.html', 'exchange.html', 'logs.html', 'styles.css', 'common.js', 'app.js', 'exchange.js', 'logs.js',
  ]);
  const server = http.createServer((req, res) => {
    const name = req.url.split('?')[0].replace(/^\//, '');
    if (PUBLIC_FILES.has(name)) {
      const file = path.join(publicDir, name);
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
      return res.end(fs.readFileSync(file));
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(tabdealHtml());
  });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const publicBase = `http://127.0.0.1:${port}`;

  // Go through src/scraper.js rather than launching Playwright directly. That is
  // the launch path the monitor actually uses, channel fallback included: this
  // used to hardcode `channel: 'msedge'`, which can never resolve on Linux, so the
  // whole suite died at this line on any machine without Edge installed — leaving
  // the browser-dependent half of the test suite permanently unrunnable.
  const browser = await getBrowser();
  const page = await browser.newPage({ locale: 'fa-IR', viewport: { width: 1440, height: 1200 } });
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(400);

  const tabdeal = require('../src/exchanges/tabdeal');
  const out = await page.evaluate(tabdeal.probeInPage, { coin: tabdeal.coin });
  const byKey = Object.fromEntries(out.probes.map((p) => [p.key, p.raw]));

  console.log('\n=== tabdeal probe ===');
  assert('ready', out.ready, true);
  assert('headline', byKey.headline, '265,460');
  assert('approx', byKey.approx, '265,460');
  // Value leaf is "265,460 تومان" — a unit suffix must not break extraction.
  assert('lastTrade', byKey.lastTrade, '265,460');
  // Price is embedded in prose.
  assert('seoText', byKey.seoText, '265,460');

  console.log('\n=== decoys must not be read ===');
  const all = Object.values(byKey);
  assert('never reads the static dollar "1"', all.includes('1'), false);
  assert('never reads a chart axis tick', all.includes('258,000'), false);
  assert('never reads a 24h high', all.includes('266,500'), false);
  assert('never reads a 24h low', all.includes('254,000'), false);
  assert('never reads a decimal volume', all.includes('3,988,749.0734'), false);
  assert('never reads the hidden gainers %', all.some((v) => String(v).includes('40.44')), false);

  console.log('\n=== data-probe tags (the visibility check reads these) ===');
  const tagged = await page.evaluate(() =>
    Object.fromEntries(
      ['headline', 'approx', 'lastTrade', 'seoText'].map((k) => [
        k, document.querySelectorAll(`[data-probe="${k}"]`).length,
      ])
    )
  );
  assert('headline tagged', tagged.headline >= 1, true);
  assert('approx tagged', tagged.approx >= 1, true);
  assert('lastTrade tagged', tagged.lastTrade >= 1, true);
  assert('seoText tagged', tagged.seoText >= 1, true);

  /* ---------- abantether: a blurred price is not a displayed price ---------- */

  // Digits are plain text in the DOM, split one <span> per character, behind a
  // CSS blur and a "log in" prompt. The text scrape must still find the value,
  // but visibility must call it obscured.
  const blurredPage = `<!doctype html><html lang="fa" dir="rtl"><body>
<div class="flex items-center gap-1">
  <span class="group relative inline-flex">
    <button type="button" aria-label="جهت مشاهده قیمت لحظه‌ای تتر وارد حساب کاربری خود شوید">
      <div class="pointer-events-none select-none" style="filter:blur(6px)">
        <div class="inline-flex items-center gap-1">
          <span>IRT</span>
          <span class="tabular-nums">
            <span>۲</span><span>۶</span><span>۷</span><span>,</span><span>۰</span><span>۵</span><span>۰</span>
          </span>
        </div>
      </div>
    </button>
  </span>
  <span>≈</span>
</div>
</body></html>`;

  // Same markup, but the blur is gone -> the price is readable -> a violation.
  const unblurredPage = blurredPage.replace(' style="filter:blur(6px)"', '');

  const abantether = require('../src/exchanges/abantether');
  const { buildReport } = require('../src/diagnose');

  async function readAbantether(html) {
    const p2 = await browser.newPage({ locale: 'fa-IR', viewport: { width: 1440, height: 1200 } });
    await p2.setContent(html, { waitUntil: 'domcontentloaded' });
    const snap = await p2.evaluate(abantether.probeInPage, { coin: abantether.coin });
    const selectors = {};
    for (const pr of snap.probes) selectors[pr.key] = `[data-probe="${pr.key}"]`;
    const { probeVisibility } = require('../src/visibility');
    const vis = await p2.evaluate(probeVisibility, { selectors });
    await p2.close();
    const probes = {};
    for (const pr of snap.probes) {
      probes[pr.key] = {
        label: pr.label,
        raw: pr.raw,
        primary: !!pr.primary,
        visible: vis[pr.key] ? vis[pr.key].visible : true,
        reason: vis[pr.key] ? vis[pr.key].reason : 'visible',
      };
    }
    return { probes, ready: snap.ready };
  }

  console.log('\n=== abantether: blurred price ===');
  const blurred = await readAbantether(blurredPage);
  const bp = blurred.probes.heroPrice;
  assert('price IS read from the DOM', bp.raw, '۲۶۷,۰۵۰');
  assert('but not visible', bp.visible, false);
  assert('reason is blurred', bp.reason, 'blurred');

  const blurredReport = buildReport({
    scrape: { exchangeId: 'abantether', ready: blurred.ready, feedLive: blurred.ready, probes: blurred.probes, durationMs: 100 },
    api: { ok: true, price: 266990, change: 2.7, error: null },
    expect: 'hidden',
    unitLabel: 'تومان',
  });
  console.log('  ' + blurredReport.description);
  assert('blurred price is compliant', blurredReport.state, 'compliant');
  assert('note mentions the blur', blurredReport.description.includes('محو و ناخوانا'), true);
  assert('note mentions the public API', blurredReport.description.includes('API عمومی'), true);
  assert('no misleading "invalid value"', blurredReport.description.includes('نامعتبر'), false);

  console.log('\n=== abantether: same page with the blur removed ===');
  const unblurred = await readAbantether(unblurredPage);
  assert('now visible', unblurred.probes.heroPrice.visible, true);
  const unblurredReport = buildReport({
    scrape: { exchangeId: 'abantether', ready: true, feedLive: true, probes: unblurred.probes, durationMs: 100 },
    api: null, expect: 'hidden', unitLabel: 'تومان',
  });
  assert('readable price IS a violation', unblurredReport.state, 'violation');
  assert('price reported', unblurredReport.price.value, 267050);

  console.log('\n=== a decorative sub-2px blur does not count as obscured ===');
  const faint = await readAbantether(blurredPage.replace('blur(6px)', 'blur(0.5px)'));
  assert('faint blur still readable', faint.probes.heroPrice.visible, true);

  /* ---------- bit24: three separate price locations, no concealment ---------- */

  // Mirrors the real markup closely enough to exercise the selectors, INCLUDING
  // the decoys: a hidden coin-list widget whose rows also contain prices, and
  // the 24h high/low that must not be selected.
  const bit24Html = `<!doctype html><html lang="fa" dir="rtl"><body>
  <div class="coin-overview__price">
    <div class="coin-price__section">
      <span class="coin-change__value">( +3.18٪) </span>
      <span class="coin-price__value d-ltr">266,000 IRT </span>
    </div>
  </div>
  <div class="coin-market__value">267,380</div>
  <div class="coin-market__value">257,550</div>
  <div class="trading-markets__row"><div class="market-price">
    <span class="market-price__value">265,801</span>
    <span class="market-price__change">(+3.17٪) </span>
  </div></div>
  <div class="b-input__field-container"><div class="b-input__content">
    <input class="b-input__field b-input__field--with-button" type="tel" placeholder="0,000" value="267,330">
    <button class="b-btn-default" aria-label="انتخاب QuoteCoin"><span>IRT</span></button>
  </div></div>
  <div class="b-input__field-container"><div class="b-input__content">
    <input class="b-input__field b-input__field--with-button" type="tel" placeholder="0,000" value="1">
    <button class="b-btn-default"><span>USDT</span></button>
  </div></div>
  <div class="b-coin-item" style="display:none">
    <span class="b-coin-item__leading-text-2">266,999 IRT</span>
  </div>
  <input class="b-input__field" type="text" placeholder="جستجوی ارز" value="">
</body></html>`;

  console.log('\n=== bit24: no concealment, three price locations ===');
  const b24 = require('../src/exchanges/bit24');
  const p3 = await browser.newPage({ locale: 'fa-IR', viewport: { width: 1440, height: 1200 } });
  await p3.setContent(bit24Html, { waitUntil: 'domcontentloaded' });
  const b24snap = await p3.evaluate(b24.probeInPage, { coin: b24.coin });
  const b24vals = Object.fromEntries(b24snap.probes.map((x) => [x.key, x.raw]));
  assert('headline', b24vals.headline, '266,000');
  assert('market tab', b24vals.market, '265,801');
  assert('buy form', b24vals.buyForm, '267,330');
  assert('never reads the 24h high', Object.values(b24vals).includes('267,380'), false);
  assert('never reads the 24h low', Object.values(b24vals).includes('257,550'), false);
  assert('never reads the hidden widget row', Object.values(b24vals).includes('266,999'), false);
  assert('never reads the amount input (1)', Object.values(b24vals).includes('1'), false);
  const b24Report = buildReport({
    scrape: {
      exchangeId: 'bit24', ready: b24snap.ready, feedLive: b24snap.feedLive, durationMs: 11000,
      probes: Object.fromEntries(b24snap.probes.map((x) => [x.key, { label: x.label, raw: x.raw, primary: !!x.primary, visible: true, reason: 'visible' }])),
      flashed: { detected: false },
    },
    api: { ok: true, price: 267330, change: null, error: null },
    expect: 'hidden', unitLabel: 'تومان',
  });
  assert('visible price is a violation', b24Report.state, 'violation');
  assert('names the headline', b24Report.price.source, 'قیمت اصلی');
  assert('unit is tomans', b24Report.price.unit, 'تومان');
  await p3.close();
  /* ---------- raastin: converter interaction, invisible chars, and decoys ---------- */

  // The fixture in test/fixtures/raastin.html reproduces the CURRENT live
  // page: the price shows nowhere at rest, and the only toman figure is the
  // buy converter's output once the probe types "1" into the tether field.
  // Traps kept from the old page: ZWNJ inside captions, a second 'IRT' badge,
  // a stale article price, and comma-grouped integers inside <script> blocks.
  const raastinHtml = fs.readFileSync(path.join(__dirname, 'fixtures', 'raastin.html'), 'utf8');

  console.log('\n=== raastin: converter typing reveals the toman figure ===');
  const raastin = require('../src/exchanges/raastin');
  const p4 = await browser.newPage({ locale: 'fa-IR', viewport: { width: 1440, height: 1200 } });
  await p4.setContent(raastinHtml, { waitUntil: 'domcontentloaded' });
  const rs = await p4.evaluate(raastin.probeInPage, { coin: raastin.coin });
  const rsv = Object.fromEntries(rs.probes.map((x) => [x.key, x.raw]));
  assert('converter output (probe typed 1 into the tether field)', rsv.converter, '268,968');
  assert('ready does not wait for hydration', rs.ready, true);
  assert('feedLive reads the converter output', rs.feedLive, true);
  assert('the probe typed into the tether field', await p4.evaluate(() => document.querySelectorAll('#price-trade input')[1].value), '1');
  assert('never reads the 24h high', Object.values(rsv).includes('271,000'), false);
  assert('never reads the stale article price', Object.values(rsv).includes('235,388'), false);
  assert('never reads a number out of a <script>',
    ['240,185', '268,000'].some((n) => Object.values(rsv).includes(n)), false);
  assert('never reads the injected "1" itself', Object.values(rsv).includes('1'), false);

  // A SECOND run must not depend on state left by the first: the field already
  // holds "1", the converter output is already filled, and the probe must read
  // it again rather than only working on a pristine page.
  const rs2 = await p4.evaluate(raastin.probeInPage, { coin: raastin.coin });
  assert('second sample reads the same figure', Object.fromEntries(rs2.probes.map((x) => [x.key, x.raw])).converter, '268,968');

  const rsReport = buildReport({
    scrape: {
      exchangeId: 'raastin', ready: rs.ready, feedLive: rs.feedLive, durationMs: 11000,
      probes: Object.fromEntries(rs.probes.map((x) => [x.key, { label: x.label, raw: x.raw, primary: !!x.primary, visible: true, reason: 'visible' }])),
      flashed: { detected: false },
    },
    api: { ok: true, price: 268968, change: 3.03, error: null },
    expect: 'hidden', unitLabel: 'تومان',
  });
  assert('converter figure is a violation', rsReport.state, 'violation');
  assert('names the converter', rsReport.price.source, 'ماشین‌حساب خرید (بابت ۱ تتر)');
  await p4.close();
  /* ---------- kifpool: no price at all, and two numbers that must stay unread ---------- */

  // The fixture reproduces the real page: the price slot holds an empty state,
  // and the only digit-bearing nodes anywhere are the '$1' USD peg and the
  // '0%' change. The peg is a genuine number > 0, so reading it would turn a
  // compliant exchange into a FALSE VIOLATION.
  const kifpoolHtml = fs.readFileSync(path.join(__dirname, 'fixtures', 'kifpool.html'), 'utf8');

  console.log('\n=== kifpool: withheld price, decoys rejected ===');
  const kifpool = require('../src/exchanges/kifpool');
  const p5 = await browser.newPage({ locale: 'fa-IR', viewport: { width: 1440, height: 1200 } });
  await p5.setContent(kifpoolHtml, { waitUntil: 'domcontentloaded' });
  const kf = await p5.evaluate(kifpool.probeInPage, { coin: kifpool.coin });
  const kfv = Object.fromEntries(kf.probes.map((x) => [x.key, x.raw]));
  assert('slot exists', kf.ready, true);
  assert('no price is read', kfv.priceSlot, null);
  assert('empty state captured', kf.probes[0].emptyText, 'موردی برای نمایش موجود نیست!');

  // The verdict, and that the empty state is quoted rather than guessed at.
  const kfReport = buildReport({
    scrape: {
      exchangeId: 'kifpool', ready: kf.ready, feedLive: kf.feedLive, durationMs: 9000,
      probes: Object.fromEntries(kf.probes.map((x) => [x.key, { label: x.label, raw: x.raw, primary: !!x.primary, visible: true, reason: 'visible', emptyText: x.emptyText }])),
      flashed: { detected: false },
    },
    api: { ok: true, price: 265775, change: 0, error: null },
    expect: 'hidden', unitLabel: 'تومان',
  });
  console.log('  ' + kfReport.description);
  assert('withheld price is compliant', kfReport.state, 'compliant');
  assert('quotes the empty state', kfReport.description.includes('موردی برای نمایش موجود نیست'), true);
  assert('does not claim the location is missing', kfReport.description.includes('پیدا نشد'), false);
  assert('notes the API still serves a price', kfReport.description.includes('API عمومی'), true);

  // If the peg were ever picked up, the verdict must flip — proving the
  // number is load-bearing and the guard is real.
  const withPeg = { priceSlot: { label: 'محل نمایش قیمت', raw: '1', primary: true, visible: true, reason: 'visible' } };
  const pegReport = buildReport({
    scrape: { exchangeId: 'kifpool', ready: true, feedLive: true, durationMs: 100, probes: withPeg, flashed: { detected: false } },
    api: null, expect: 'hidden', unitLabel: 'تومان',
  });
  assert('reading the $1 peg would be a violation', pegReport.state, 'violation');
  await p5.close();

  // Both tenants share one probe implementation; assert that they really do,
  // so a future per-tenant fork cannot silently diverge.
  const whiteLabel = require('../src/exchanges/whiteLabel');
  const raastinAdapter = require('../src/exchanges/raastin');
  const arzplusAdapter = require('../src/exchanges/arzplus');
  assert('raastin and arzplus share one probe', raastinAdapter.probeInPage === arzplusAdapter.probeInPage, true);
  assert('...and one feed parser', raastinAdapter.api.parse === arzplusAdapter.api.parse, true);
  assert('tenants differ only in identity', raastinAdapter.id !== arzplusAdapter.id && raastinAdapter.url !== arzplusAdapter.url, true);

  /* ---------- wallex: the SSR price flashes, then the page withdraws it ---------- */

  // The fixture reproduces the measured live behaviour: six captioned slots
  // priced in the served document, ALL of them withdrawn ~250ms in (fixture
  // speed for the live ~1.2s) — headline/dollar/converter/current swap to «—»,
  // the high/low rows vanish, and comma-grouped volume figures keep ticking.
  const wallexHtml = fs.readFileSync(path.join(__dirname, 'fixtures', 'wallex.html'), 'utf8');

  console.log('\n=== wallex: flash then withdrawal ===');
  const wallex = require('../src/exchanges/wallex');
  const pw = await browser.newPage({ locale: 'fa-IR', viewport: { width: 1440, height: 1200 } });
  await pw.setContent(wallexHtml, { waitUntil: 'domcontentloaded' });
  const wx1 = await pw.evaluate(wallex.probeInPage, { coin: wallex.coin });
  assert('ready from the served document', wx1.ready, true);
  const wx1v = Object.fromEntries(wx1.probes.map((x) => [x.key, x.raw]));
  assert('headline (SSR)', wx1v.headline, '258,118');
  assert('dollar', wx1v.dollar, '$1');
  assert('converter (caption is a div, value a span)', wx1v.converter, '258,118');
  assert('current', wx1v.current, '258,117');
  assert('high', wx1v.high, '258,138');
  assert('low', wx1v.low, '257,951');
  assert('never reads the volume figures',
    ['71,747,521,964', '184,063,638,247'].some((n) => Object.values(wx1v).includes(n)), false);

  // After the withdrawal. The scans past the surviving captions must stop at
  // the «—» placeholders and the vanished captions must return null — the
  // volume figures sit right there and would otherwise be read as prices.
  await pw.waitForTimeout(700);
  const wx2 = await pw.evaluate(wallex.probeInPage, { coin: wallex.coin });
  const wx2v = Object.fromEntries(wx2.probes.map((x) => [x.key, x.raw]));
  assert('headline withdrawn to the dash', wx2v.headline, '—');
  assert('dollar withdrawn', wx2v.dollar, '—');
  assert('high/low rows removed outright', wx2v.high, null);
  assert('no comma-grouped decoy read after withdrawal',
    Object.values(wx2v).some((v) => /^\d{1,3}(?:,\d{3})+$/.test(String(v))), false);

  // Judged: a price that was seen and then withdrawn is the documented flash —
  // compliant, with the flash note carrying the number nobody ends up seeing.
  const wxReport = buildReport({
    scrape: {
      exchangeId: 'wallex', ready: wx2.ready, feedLive: true, durationMs: 9000,
      probes: Object.fromEntries(wx2.probes.map((x) => [x.key, { label: x.label, raw: x.raw, primary: !!x.primary, visible: true, reason: 'visible' }])),
      flashed: { detected: true, price: '258,118', durationMs: 1200 },
    },
    api: { ok: true, price: 258118, change: 0.5, error: null },
    expect: 'hidden', unitLabel: 'تومان',
  });
  console.log('  ' + wxReport.title);
  assert('withdrawn price is compliant', wxReport.state, 'compliant');
  assert('the flash is reported', wxReport.flashNote.includes('۲۵۸,۱۱۸'), true);
  await pw.close();

  /* ---------- pooleno: a real zero, and neighbours that look like prices ---------- */

  // The tether slot holds a genuine server-rendered zero. The trap is that the
  // same page publishes USDC / BTC / ETH prices in the exact monitored band, so
  // an over-broad selector would report a violation that is not there.
  const poolenoHtml = fs.readFileSync(path.join(__dirname, 'fixtures', 'pooleno.html'), 'utf8');

  console.log('\n=== pooleno: zeroed slot, neighbour assets never read ===');
  const pooleno = require('../src/exchanges/pooleno');
  const p6 = await browser.newPage({ locale: 'fa-IR', viewport: { width: 1440, height: 1200 } });
  await p6.setContent(poolenoHtml, { waitUntil: 'domcontentloaded' });
  const pl = await p6.evaluate(pooleno.probeInPage, { coin: pooleno.coin });
  const plv = Object.fromEntries(pl.probes.map((x) => [x.key, x.raw]));
  assert('slot found', pl.ready, true);
  assert('reads the zeroed slot', plv.priceSlot, '۰');
  assert('never reads the USDC price', plv.priceSlot === '۲۶۹,۲۰۹', false);
  assert('never reads the BTC price', plv.priceSlot === '۲۲,۷۷۵,۸۱۷,۲۹۳', false);
  assert('never reads the ETH price', plv.priceSlot === '۷۲۱,۹۶۰,۱۲۷', false);

  // The bare selector really is ambiguous — pin that, so nobody 'simplifies' it later.
  const counts = await p6.evaluate(() => ({
    bare: document.querySelectorAll('#price-usdt-detail-summary strong').length,
    scoped: document.querySelectorAll('#price-usdt-detail-summary div[dir="ltr"] > div:first-child strong').length,
  }));
  assert('bare strong is ambiguous', counts.bare > 1, true);
  assert('scoped selector is exact', counts.scoped, 1);

  const plReport = buildReport({
    scrape: {
      exchangeId: 'pooleno', ready: pl.ready, feedLive: pl.feedLive, durationMs: 9000,
      probes: Object.fromEntries(pl.probes.map((x) => [x.key, { label: x.label, raw: x.raw, primary: !!x.primary, visible: true, reason: 'visible' }])),
      flashed: { detected: false },
    },
    api: null, expect: 'hidden', unitLabel: 'تومان',
  });
  console.log('  ' + plReport.description);
  assert('zeroed slot is compliant', plReport.state, 'compliant');
  assert('explains it as a zero', plReport.description.includes('صفر'), true);
  await p6.close();

  /* ---------- tetherland: a clear violation, buried in near misses ---------- */

  // The price IS shown here — plainly, in large type. The difficulty is not
  // finding it, it is not reading one of the four near-misses that sit within a
  // few hundred tomans of it on the same screen.
  const tlHtml = fs.readFileSync(path.join(__dirname, 'fixtures', 'tetherland.html'), 'utf8');

  console.log('\n=== tetherland: the one real price, and the four near misses ===');
  const tetherland = require('../src/exchanges/tetherland');
  const { probeVisibility } = require('../src/visibility');
  const p7 = await browser.newPage({ locale: 'fa-IR', viewport: { width: 1440, height: 1200 } });
  await p7.setContent(tlHtml, { waitUntil: 'domcontentloaded' });
  const tl = await p7.evaluate(tetherland.probeInPage, { coin: tetherland.coin });
  const tlv = Object.fromEntries(tl.probes.map((x) => [x.key, x.raw]));
  console.log('  ' + JSON.stringify(tlv));

  assert('price slot found', tl.ready, true);
  assert('reads the tether price', tlv.priceSlot, '268,350');

  // Each near miss asserted by name. These are cheap, but they are the whole
  // reason this adapter exists, so they are spelled out rather than implied.
  assert('never reads the 24h high (268,800)', tlv.priceSlot === '268,800', false);
  assert('never reads the 24h low (260,450)', tlv.priceSlot === '260,450', false);
  assert('never reads the 24h change (3.03)', tlv.priceSlot === '3.03', false);
  assert('never reads the raw data-att (268350)', tlv.priceSlot === '268350', false);
  assert('never reads the calculator total', tlv.priceSlot === '0 تومان', false);
  assert('never reads a carousel price (84,640.3 تتر)', tlv.priceSlot === '84,640.3', false);

  // Pin the selector precision itself: the bare class is wildly ambiguous.
  const tlCounts = await p7.evaluate(() => ({
    id: document.querySelectorAll('#currentPrice').length,
    bare: document.querySelectorAll('.price').length,
  }));
  assert('#currentPrice is exact', tlCounts.id, 1);
  assert('bare .price is ambiguous', tlCounts.bare > 1, true);

  // The probe tag is on the number itself, so the shared visibility gate asks
  // about exactly what was read. There is no `data-monitor` any more: the
  // evidence image is the whole page, so no adapter tags an element for it.
  const tlTags = await p7.evaluate(() => ({
    probe: document.querySelectorAll('[data-probe="priceSlot"]').length,
    probeIsPrice: document.querySelector('[data-probe="priceSlot"]').id,
    monitor: document.querySelectorAll('[data-monitor]').length,
  }));
  assert('one data-probe, on the number', tlTags.probe === 1 && tlTags.probeIsPrice === 'currentPrice', true);
  assert('nothing is tagged for element capture', tlTags.monitor, 0);

  // The shared visibility gate must agree the price is on screen.
  const tlVis = await p7.evaluate(probeVisibility, { selectors: { priceSlot: '[data-probe="priceSlot"]' } });
  assert('price is visible', tlVis.priceSlot.visible, true);
  assert('visibility reason', tlVis.priceSlot.reason, 'visible');

  const tlReport = buildReport({
    scrape: {
      exchangeId: 'tetherland', ready: tl.ready, feedLive: tl.feedLive, durationMs: 9000,
      probes: Object.fromEntries(tl.probes.map((x) => [x.key, { label: x.label, raw: x.raw, primary: !!x.primary, visible: true, reason: 'visible' }])),
      flashed: { detected: false },
    },
    api: { ok: true, price: 268350, change: 3.03, error: null },
    expect: 'hidden', unitLabel: 'تومان',
  });
  console.log('  ' + tlReport.description);
  assert('shown price is a violation', tlReport.state, 'violation');
  assert('price value', tlReport.price.value, 268350);
  assert('price unit is tomans', tlReport.price.unit, 'تومان');
  await p7.close();

  // The API parser must take `price` and not the 24h high sitting beside it.
  console.log('\n=== tetherland: the API endpoint carries the same traps ===');
  const tlParsed = tetherland.api.parse(JSON.stringify({
    price: 268350, sell_price: 268350, buy_price: 268350,
    diff24d: '3.03', last24hMin: 260450, last24hMax: 268800, last7d: 233450,
  }));
  assert('api reads the spot price', tlParsed.price, 268350);
  assert('api does not read last24hMax', tlParsed.price === 268800, false);
  assert('api does not read last7d', tlParsed.price === 233450, false);
  assert('api change', tlParsed.change, 3.03);
  assert('api unit is tomans', tlParsed.unitScale, 1);

  // PROVENANCE. On the live page `.cskie[data-att]` currently holds 268350 —
  // the SAME number as the visible price — so comparing values cannot prove we
  // read the right element. Empty the visible slot and leave the attribute
  // intact: a probe that ever reached for the attribute would then report a
  // violation on a page that shows nothing.
  console.log('\n=== tetherland: provenance — the data-att is not a fallback source ===');
  const p8 = await browser.newPage({ locale: 'fa-IR', viewport: { width: 1440, height: 1200 } });
  const tlNoPrice = tlHtml.replace(
    '<span class="price" id="currentPrice">268,350 تومان</span>',
    '<span class="price" id="currentPrice">--</span>'
  );
  assert('the variant really did empty the slot', tlNoPrice.includes('id="currentPrice">--<'), true);
  await p8.setContent(tlNoPrice, { waitUntil: 'domcontentloaded' });
  const tl8 = await p8.evaluate(tetherland.probeInPage, { coin: tetherland.coin });
  assert('does not fall back to data-att', Object.values(Object.fromEntries(tl8.probes.map((x) => [x.key, x.raw])))[0] === '268350', false);
  const tl8Report = buildReport({
    scrape: {
      exchangeId: 'tetherland', ready: tl8.ready, feedLive: tl8.feedLive, durationMs: 9000,
      probes: Object.fromEntries(tl8.probes.map((x) => [x.key, { label: x.label, raw: x.raw, primary: !!x.primary, visible: true, reason: 'visible' }])),
      flashed: { detected: false },
    },
    api: { ok: true, price: 268350, change: 3.03, error: null },
    expect: 'hidden', unitLabel: 'تومان',
  });
  assert('an empty slot would be compliant', tl8Report.state, 'compliant');

  // The page renders Latin digits today, but that is a client-side formatting
  // choice. Persian digits must classify identically.
  const p9 = await browser.newPage({ locale: 'fa-IR', viewport: { width: 1440, height: 1200 } });
  await p9.setContent(tlHtml.replace('268,350 تومان', '۲۶۸,۳۵۰ تومان'), { waitUntil: 'domcontentloaded' });
  const tl9 = await p9.evaluate(tetherland.probeInPage, { coin: tetherland.coin });
  const tl9raw = Object.values(Object.fromEntries(tl9.probes.map((x) => [x.key, x.raw])))[0];
  assert('reads persian digits', tl9raw, '۲۶۸,۳۵۰');
  const tl9Report = buildReport({
    scrape: {
      exchangeId: 'tetherland', ready: tl9.ready, feedLive: tl9.feedLive, durationMs: 9000,
      probes: Object.fromEntries(tl9.probes.map((x) => [x.key, { label: x.label, raw: x.raw, primary: !!x.primary, visible: true, reason: 'visible' }])),
      flashed: { detected: false },
    },
    api: { ok: true, price: 268350, change: 3.03, error: null },
    expect: 'hidden', unitLabel: 'تومان',
  });
  assert('persian digits give the same value', tl9Report.price.value, 268350);
  assert('persian digits are still a violation', tl9Report.state, 'violation');
  await p9.close();

  // The visibility gate is what decides, not the selector. Hide the element and
  // the verdict must flip — this is the guard that keeps the monitor honest if
  // تترلند ever decides to conceal the price instead of publishing it.
  const p10 = await browser.newPage({ locale: 'fa-IR', viewport: { width: 1440, height: 1200 } });
  await p10.setContent(
    tlHtml.replace('</head>', '<style>#currentPrice{display:none}</style></head>'),
    { waitUntil: 'domcontentloaded' }
  );
  const tl10 = await p10.evaluate(tetherland.probeInPage, { coin: tetherland.coin });
  const tl10vis = await p10.evaluate(probeVisibility, { selectors: { priceSlot: '[data-probe="priceSlot"]' } });
  assert('hidden element is reported not-rendered', tl10vis.priceSlot.visible, false);
  assert('...for the right reason', tl10vis.priceSlot.reason, 'not-rendered');
  const tl10Report = buildReport({
    scrape: {
      exchangeId: 'tetherland', ready: tl10.ready, feedLive: tl10.feedLive, durationMs: 9000,
      probes: Object.fromEntries(tl10.probes.map((x) => [x.key, {
        label: x.label, raw: x.raw, primary: !!x.primary,
        visible: tl10vis.priceSlot.visible, reason: tl10vis.priceSlot.reason,
      }])),
      flashed: { detected: false },
    },
    api: { ok: true, price: 268350, change: 3.03, error: null },
    expect: 'hidden', unitLabel: 'تومان',
  });
  console.log('  ' + tl10Report.description);
  assert('a display:none price would be compliant', tl10Report.state, 'compliant');
  await p8.close();
  await p10.close();

  /* ---------- sarmayex: one price in three places, and four traps ---------- */

  // سرمایکس is the opposite problem from tetherland: instead of four near
  // misses around one price, it publishes the SAME price three times and hides
  // nothing. The danger is reading one of the traps, or reading the wrong coin.
  const sxHtml = fs.readFileSync(path.join(__dirname, 'fixtures', 'sarmayex.html'), 'utf8');

  console.log('\n=== sarmayex: three display sites, four traps ===');
  const sarmayex = require('../src/exchanges/sarmayex');
  const p11 = await browser.newPage({ locale: 'fa-IR', viewport: { width: 1440, height: 1200 } });
  await p11.setContent(sxHtml, { waitUntil: 'domcontentloaded' });
  const sx = await p11.evaluate(sarmayex.probeInPage, { coin: sarmayex.coin });
  const sxv = Object.fromEntries(sx.probes.map((x) => [x.key, x.raw]));
  console.log('  ' + JSON.stringify(sxv));

  assert('all three sites found', sx.probes.length, 3);
  // Live digit formats differ BY LOCATION: the ticker is Latin, the table and
  // the card are Persian with U+066C. All three must still resolve.
  assert('ticker reads latin digits', sxv.tape, '267,433');
  assert('table reads persian digits', sxv.table, '۲۶۷٬۴۳۳');
  assert('card reads persian digits', sxv.card, '۲۶۷٬۴۳۳');

  // The volume column is mixed-format (`۴۶٬۱۴۴.51`) and parses cleanly into
  // 46144.51 — read it and you report a fabricated violation.
  assert('never reads the 24h volume', [sxv.tape, sxv.table, sxv.card].includes('۴۶٬۱۴۴.51'), false);
  assert('never reads the change badge', [sxv.tape, sxv.table, sxv.card].includes('0.256'), false);
  assert('never reads Tether-Gold', [sxv.tape, sxv.table, sxv.card].includes('۱٬۱۱۳٬۴۳۶٬۱۶۰'), false);
  assert('never reads the BTC row', [sxv.tape, sxv.table, sxv.card].includes('۲۲٬۶۸۶٬۳۱۹٬۷۷۶'), false);
  assert('never reads the BTC_USDT ticker quote', [sxv.tape, sxv.table, sxv.card].includes('84,857.88'), false);

  // Selector precision, pinned so nobody "simplifies" it later.
  const sxCounts = await p11.evaluate(() => ({
    tableUsdt: document.querySelectorAll('table tbody tr a[href$="/trade/USDT_IRT"]').length,
    starUsdt: document.querySelectorAll('a[href*="USDT"]').length,
    endUsdtIrt: document.querySelectorAll('a[href$="/trade/USDT_IRT"]').length,
    heroIcon: document.querySelectorAll('img[alt="USDT icon"]').length,
    altTether: document.querySelectorAll('[alt="تتر"]').length,
    rowsMentioningTether: Array.from(document.querySelectorAll('tr')).filter((t) => t.textContent.includes('تتر')).length,
    bodyRowsMentioningTether: Array.from(document.querySelectorAll('tbody tr')).filter((t) => t.textContent.includes('تتر')).length,
  }));
  assert('exactly one tether row in the table', sxCounts.tableUsdt, 1);
  assert('the hero icon is unique', sxCounts.heroIcon, 1);
  // The whole reason the adapter anchors on the pair: this is the ambiguity.
  assert('a bare href*=USDT is wildly ambiguous', sxCounts.starUsdt > 3, true);
  assert('the exact suffix matches all three sites', sxCounts.endUsdtIrt, 3);
  // The «تتر گلد» trap, measured: within the table BODY two rows contain the
  // word تتر, and the exact-attribute rule picks the real one. (A third match
  // sits in the <thead>, in the تومان/تتر unit toggle — another reason caption
  // matching is unsafe here.)
  assert('two body rows contain the word تتر', sxCounts.bodyRowsMentioningTether, 2);
  assert('the header toggle adds a third', sxCounts.rowsMentioningTether, 3);
  assert('exact [alt="تتر"] skips Tether-Gold', sxCounts.altTether, 1);

  // Every probe tags exactly one element for the shared visibility gate. Nothing
  // is tagged for element capture any more: the evidence image is the whole page.
  const sxTags = await p11.evaluate(() => {
    const info = (key) => ({
      probe: document.querySelectorAll('[data-probe="' + key + '"]').length,
      monitor: document.querySelectorAll('[data-monitor]').length,
    });
    return { tape: info('tape'), table: info('table'), card: info('card') };
  });
  assert('tape probed once', sxTags.tape.probe, 1);
  assert('table probes the leaf once', sxTags.table.probe, 1);
  assert('card probes the span once', sxTags.card.probe, 1);
  assert('nothing is tagged for element capture', sxTags.table.monitor, 0);

  // The card sits on `backdrop-filter: blur(5px)`. That is decorative glass
  // BEHIND the card; it must not be mistaken for the blur used by آبان‌تتر to
  // hide its price. backdrop-filter blurs what is behind an element, not its
  // own text, so the check inspects `filter` only — pinned here.
  const sxBlur = await p11.evaluate(() => {
    const el = document.querySelector('[data-probe="card"]');
    let n = el, backdrop = 'none', own = 'none';
    while (n && n !== document.documentElement) {
      const cs = getComputedStyle(n);
      if (cs.backdropFilter && cs.backdropFilter !== 'none' && backdrop === 'none') backdrop = cs.backdropFilter;
      if (cs.filter && cs.filter !== 'none') own = cs.filter;
      n = n.parentElement;
    }
    return { backdrop, own };
  });
  assert('the card really does carry a backdrop blur', sxBlur.backdrop.includes('blur'), true);
  assert('...and no filter blur on itself', sxBlur.own, 'none');
  // No scrolling: this fixture is tall and the card sits well below the fold,
  // yet it must still count as displayed. Being outside our viewport is a fact
  // about where WE are looking, not about what the page shows — a user scrolls
  // and reads it. Getting this wrong inverted the verdict on a page that shows
  // the price in plain sight.
  const sxVis = await p11.evaluate(probeVisibility, { selectors: { tape: '[data-probe="tape"]', table: '[data-probe="table"]', card: '[data-probe="card"]' } });
  assert('a below-the-fold card counts as displayed', sxVis.card.visible, true);
  assert('...with the right reason', sxVis.card.reason, 'visible');
  assert('the below-the-fold table row counts as displayed', sxVis.table.visible, true);
  assert('a backdrop-blurred card is still visible', sxVis.card.visible, true);

  // The converse must NOT have been broken: content locked inside a clipping
  // ancestor is genuinely unreachable, and is still reported as not displayed.
  // This is the ramzinex carousel case, and it is what protects the monitor
  // from reporting a violation nobody could ever see.
  const p11b = await browser.newPage({ locale: 'fa-IR', viewport: { width: 1440, height: 1200 } });
  await p11b.setContent(
    '<!doctype html><html lang="fa" dir="rtl"><body style="margin:0">' +
    // Absolutely positioned so the placement is physical and direction-
    // independent; the span sits 600px to the right of a 300px-wide track.
    '<div id="track" style="position:relative;overflow:hidden;width:300px;height:60px">' +
    '<span id="locked" style="position:absolute;left:900px;top:8px;padding:8px">۲۶۸٬۹۹۳</span>' +
    '</div></body></html>',
    { waitUntil: 'domcontentloaded' }
  );
  const sxLocked = await p11b.evaluate(probeVisibility, { selectors: { locked: '#locked' } });
  assert('content clipped out of an overflow:hidden track is NOT displayed', sxLocked.locked.visible, false);
  assert('...reported as clipped', sxLocked.locked.reason, 'clipped');
  await p11b.close();

  const sxReport = buildReport({
    scrape: {
      exchangeId: 'sarmayex', ready: sx.ready, feedLive: sx.feedLive, durationMs: 11000,
      probes: Object.fromEntries(sx.probes.map((x) => [x.key, { label: x.label, raw: x.raw, primary: !!x.primary, visible: true, reason: 'visible' }])),
      flashed: { detected: false },
    },
    api: { ok: true, price: 268993, change: 2.822, error: null },
    expect: 'hidden', unitLabel: 'تومان',
  });
  console.log('  ' + sxReport.description);
  assert('shown price is a violation', sxReport.state, 'violation');
  // Persian digits must survive the whole path: probe -> classify -> report.
  assert('persian digits give the right number', sxReport.price.value, 267433);
  assert('unit is tomans', sxReport.price.unit, 'تومان');
  await p11.close();

  // The API is a flat map of 31 pairs; only `USDT_IRT` is the tether market.
  console.log('\n=== sarmayex: the API map holds 31 pairs and 4 decoys ===');
  const sxParsed = sarmayex.api.parse(JSON.stringify({
    data: {
      USDT_IRT: { price: '268993', ticker_last: '268993', change_percent: '2.822', ticker_high: '269000', ticker_low: '259334', ticker_volume: '46167.6015625', ticker_quote_volume: '12173400064', quote_locale_name: 'تومان' },
      BTC_IRT: { price: '84710.11' },
      BTC_USDT: { price: '84857.88' },
    },
  }));
  assert('api reads the USDT_IRT price', sxParsed.price, 268993);
  assert('api does not read ticker_high', sxParsed.price === 269000, false);
  assert('api does not read the quote volume', sxParsed.price === 12173400064, false);
  assert('api change', sxParsed.change, 2.822);
  assert('api unit is tomans', sxParsed.unitScale, 1);
  assert('api is null when the pair is missing', sarmayex.api.parse(JSON.stringify({ data: { BTC_IRT: {} } })), null);

  // If the volume column were ever reached, it parses into a plausible number —
  // so prove the probe cannot produce it, on a page where it is the only
  // comma-grouped neighbour.
  const p12 = await browser.newPage({ locale: 'fa-IR', viewport: { width: 1440, height: 1200 } });
  await p12.setContent(sxHtml.replace('۲۶۷٬۴۳۳</div>', '—</div>'), { waitUntil: 'domcontentloaded' });
  const sx12 = await p12.evaluate(sarmayex.probeInPage, { coin: sarmayex.coin });
  const sx12v = Object.fromEntries(sx12.probes.map((x) => [x.key, x.raw]));
  console.log('  with the table price blanked: ' + JSON.stringify(sx12v));
  assert('the table probe reports nothing, not the volume', sx12v.table, null);
  await p12.close();

  /* ---------- hamtapay: two locations, fifteen ways to be wrong ---------- */

  // همتاپی anchors on the word «تومان» rather than on a class, because the
  // obvious class — .tabular-nums — matches fifteen elements on this page.
  // Nine of them are comma-grouped, non-zero and would each read as a price.
  const hpHtml = fs.readFileSync(path.join(__dirname, 'fixtures', 'hamtapay.html'), 'utf8');

  console.log('\n=== hamtapay: the تومان anchor, and fifteen tabular-nums decoys ===');
  const hamtapay = require('../src/exchanges/hamtapay');
  const p13 = await browser.newPage({ locale: 'fa-IR', viewport: { width: 1440, height: 1200 } });
  await p13.setContent(hpHtml, { waitUntil: 'domcontentloaded' });
  const hp = await p13.evaluate(hamtapay.probeInPage, { coin: hamtapay.coin });
  const hpv = Object.fromEntries(hp.probes.map((x) => [x.key, x.raw]));
  console.log('  ' + JSON.stringify(hpv));

  assert('both locations found', hp.probes.length, 2);
  // Persian digits with a LATIN comma — the same in both locations.
  assert('header reads the price', hpv.header, '۲۶۸,۹۱۳');
  assert('strip mirrors the price', hpv.strip, '۲۶۸,۹۱۳');

  // Each decoy, asserted by name. These are the strings a sloppy reader takes.
  const read = [hpv.header, hpv.strip];
  assert('never reads the market cap', read.includes('۱۸۳,۸۷۰,۶۸۳,۹۹۸.۹۲'), false);
  assert('never reads the BTC dropdown price', read.includes('84,878.01'), false);
  assert('never reads the BNB dropdown price', read.includes('774.27'), false);
  assert('never reads the dollar peg', read.includes('۱'), false);
  assert('never reads the BTC market cap', read.includes('۲۲,۸۳۱,۱۵۰,۴۲۵'), false);
  assert('never reads the ETH market cap', read.includes('۷۲۱,۶۷۲,۶۳۱'), false);
  assert('never reads a chart axis tick', read.includes('۲۶۹K'), false);
  assert('never reads the em-dash placeholder', read.includes('—'), false);

  // The selector precision, measured. These pin the two rules the adapter rests
  // on, so a later "simplification" cannot silently break them.
  const hpCounts = await p13.evaluate(() => ({
    tomanSpans: Array.from(document.querySelectorAll('span')).filter((s) => s.textContent.replace(/\s+/g, ' ').trim() === 'تومان').length,
    tabular: document.querySelectorAll('.tabular-nums').length,
    // The bare class selector is hopeless here; the unit-word anchor is exact.
    bareTabularPrice: document.querySelectorAll('.tabular-nums').length,
    stripExact: document.querySelectorAll('a[href="/markets/USDT"].router-link-exact-active').length,
    stripLoose: document.querySelectorAll('a[href="/markets/USDT"]').length,
  }));
  assert('the تومان anchor is unique', hpCounts.tomanSpans, 1);
  assert('.tabular-nums is hopeless as a selector', hpCounts.tabular, 15);
  assert('the strip row is exact', hpCounts.stripExact, 1);
  assert('the bare href is already exact here, but only one row', hpCounts.stripLoose, 1);

  // Each surface tags exactly one element for the visibility gate; nothing is
  // tagged for element capture any more.
  const hpTags = await p13.evaluate(() => {
    const info = (key) => ({
      probe: document.querySelectorAll('[data-probe="' + key + '"]').length,
      monitor: document.querySelectorAll('[data-monitor]').length,
    });
    return { header: info('header'), strip: info('strip') };
  });
  assert('header probes once', hpTags.header.probe, 1);
  assert('strip probes once', hpTags.strip.probe, 1);
  assert('nothing is tagged for element capture', hpTags.header.monitor, 0);

  // The concealment gate must keep working here too: the dropdown prices are
  // comma-grouped and non-zero, and only their display:none ancestor stops
  // them being reported.
  const hpVis = await p13.evaluate(probeVisibility, { selectors: {
    header: '[data-probe="header"]',
    strip: '[data-probe="strip"]',
    dropdown: '.header-submenu-panel .tabular-nums',
  } });
  assert('the price is visible', hpVis.header.visible, true);
  assert('the mirrored price is visible', hpVis.strip.visible, true);
  assert('the display:none dropdown prices are not displayed', hpVis.dropdown.visible, false);

  const hpReport = buildReport({
    scrape: {
      exchangeId: 'hamtapay', ready: hp.ready, feedLive: hp.feedLive, durationMs: 11000,
      probes: Object.fromEntries(hp.probes.map((x) => [x.key, { label: x.label, raw: x.raw, primary: !!x.primary, visible: true, reason: 'visible' }])),
      flashed: { detected: false },
    },
    api: { ok: true, price: 268696, change: 2.83, error: null },
    expect: 'hidden', unitLabel: 'تومان',
  });
  console.log('  ' + hpReport.description);
  assert('shown price is a violation', hpReport.state, 'violation');
  // Persian digits + a Latin comma must survive probe -> classify -> report.
  assert('persian digits give the right number', hpReport.price.value, 268913);
  assert('unit is tomans', hpReport.price.unit, 'تومان');
  await p13.close();

  // Latin digits must work identically — the site uses them for the dropdown.
  // Global: the fixture mentions the Persian price in a comment as well, so a
  // single-shot replace would edit the comment and prove nothing.
  const p14 = await browser.newPage({ locale: 'fa-IR', viewport: { width: 1440, height: 1200 } });
  await p14.setContent(hpHtml.replace(/۲۶۸,۹۱۳/g, '268,913'), { waitUntil: 'domcontentloaded' });
  const hp14 = await p14.evaluate(hamtapay.probeInPage, { coin: hamtapay.coin });
  const hp14v = Object.fromEntries(hp14.probes.map((x) => [x.key, x.raw]));
  assert('latin digits read identically', [hp14v.header, hp14v.strip], ['268,913', '268,913']);
  const hp14Report = buildReport({
    scrape: {
      exchangeId: 'hamtapay', ready: hp14.ready, feedLive: hp14.feedLive, durationMs: 11000,
      probes: Object.fromEntries(hp14.probes.map((x) => [x.key, { label: x.label, raw: x.raw, primary: !!x.primary, visible: true, reason: 'visible' }])),
      flashed: { detected: false },
    },
    api: { ok: true, price: 268696, change: 2.83, error: null },
    expect: 'hidden', unitLabel: 'تومان',
  });
  assert('latin digits are still a violation', hp14Report.state, 'violation');
  assert('latin digits give the same value', hp14Report.price.value, 268913);
  await p14.close();

  // THE STRIP RENDERS LATE. It is absent from the early DOM and appears after
  // hydration. An adapter that treated its absence as "page not ready" would
  // report نامشخص on every fast sample, so it must be optional.
  console.log('\n=== hamtapay: the strip is optional, never a readiness failure ===');
  const p15 = await browser.newPage({ locale: 'fa-IR', viewport: { width: 1440, height: 1200 } });
  await p15.setContent(hpHtml.replace(/<li><a aria-current="page"[\s\S]*?<\/li>/, ''), { waitUntil: 'domcontentloaded' });
  const hp15 = await p15.evaluate(hamtapay.probeInPage, { coin: hamtapay.coin });
  const hp15v = Object.fromEntries(hp15.probes.map((x) => [x.key, x.raw]));
  assert('the page is still ready without the strip', hp15.ready, true);
  assert('the header alone still reads the price', hp15v.header, '۲۶۸,۹۱۳');
  assert('the absent strip simply reports nothing', hp15v.strip, null);
  const hp15Report = buildReport({
    scrape: {
      exchangeId: 'hamtapay', ready: hp15.ready, feedLive: hp15.feedLive, durationMs: 11000,
      probes: Object.fromEntries(hp15.probes.map((x) => [x.key, { label: x.label, raw: x.raw, primary: !!x.primary, visible: true, reason: 'visible' }])),
      flashed: { detected: false },
    },
    api: { ok: true, price: 268696, change: 2.83, error: null },
    expect: 'hidden', unitLabel: 'تومان',
  });
  assert('header alone is still a violation', hp15Report.state, 'violation');
  await p15.close();

  // The endpoint is public and headerless, but one object carries three
  // plausible numbers: market_price, a 27-digit sell/buy pair, and an avg.
  console.log('\n=== hamtapay: one object, three plausible numbers ===');
  const hpParsed = hamtapay.api.parse(JSON.stringify({
    data: {
      'USDT-IRT': {
        sell: '267994.749491180461286048724875',
        buy: '270682.761020680766815497558625',
        market_price: 268696,
        change_rate_24h: 2.83,
        volume_24h: 518600.62,
        volume_24h_usdt: 518600.62,
        min_price_24h: 261171,
        max_price_24h: 269120,
        avg: '269338.75525593061405077314',
      },
      'BTC-IRT': { market_price: 85000 },
    },
  }));
  assert('api reads market_price', hpParsed.price, 268696);
  assert('api does not read sell', hpParsed.price === 267994.74949118046, false);
  assert('api does not read buy', hpParsed.price === 270682.7610206808, false);
  assert('api does not read the rolling avg', hpParsed.price === 269338.7552559306, false);
  assert('api does not read max_price_24h', hpParsed.price === 269120, false);
  assert('api change', hpParsed.change, 2.83);
  assert('api unit is tomans', hpParsed.unitScale, 1);
  assert('api is null without the pair', hamtapay.api.parse(JSON.stringify({ data: { 'BTC-IRT': {} } })), null);

  /* ---------- arzinja: five locations, and two decoys 50 tomans away ---------- */

  // ارزینجا publishes the same price in five places. Two of the techniques that
  // worked on earlier sites actively fail here, and both traps are on the page.
  const azHtml = fs.readFileSync(path.join(__dirname, 'fixtures', 'arzinja.html'), 'utf8');

  console.log('\n=== arzinja: five sites, and the two techniques that break here ===');
  const arzinja = require('../src/exchanges/arzinja');
  const p16 = await browser.newPage({ locale: 'fa-IR', viewport: { width: 1440, height: 1200 } });
  await p16.setContent(azHtml, { waitUntil: 'domcontentloaded' });
  const az = await p16.evaluate(arzinja.probeInPage, { coin: arzinja.coin });
  const azv = Object.fromEntries(az.probes.map((x) => [x.key, x.raw]));
  console.log('  ' + JSON.stringify(azv));

  assert('all five sites found', az.probes.length, 5);
  // Four of the five agree exactly; the market table quotes a different figure
  // for the same pair, which is still a disclosure.
  assert('hero price', azv.hero, '۲۶۸,۵۰۵');
  assert('stat card price', azv.card, '۲۶۸,۵۰۵');
  assert('instant-trade ticker price', azv.ticker, '۲۶۸,۵۰۵');
  assert('sidebar price', azv.sidebar, '۲۶۸,۵۰۵');
  assert('market table quotes the same pair separately', azv.marketTable, '۲۶۸,۷۵۰');

  // Every decoy, asserted by name.
  const azRead = Object.values(azv);
  assert('never reads the TUSD near-miss', azRead.includes('۲۶۸,۴۵۱'), false);
  assert('never reads the USDC near-miss', azRead.includes('۲۶۸,۵۵۸'), false);
  assert('never reads the 24h high', azRead.includes('۲۶۹,۵۸۵'), false);
  assert('never reads the 24h low', azRead.includes('۲۶۲,۶۰۵'), false);
  assert('never reads the market volume', azRead.includes('۷۱,۱۵۴.۵۲'), false);
  assert('never reads circulating supply', azRead.includes('۱۸۴,۰۵۷,۷۱۳,۹۸۳.۹۳'), false);
  assert('never reads the stale prose figure', azRead.includes('۹۰٬۷۸۸'), false);
  assert('never reads the peg', azRead.includes('۱'), false);
  assert('never reads the stale __NEXT_DATA__ price', azRead.includes('267990'), false);

  // TRAP 1 — `.tabular-nums` is a trap here, not a shortcut. The peg is FIRST
  // in document order, so the bare class returns the $1 peg rather than the
  // price. Pinned so nobody "simplifies" the selector to the bare class.
  const azCounts = await p16.evaluate(() => ({
    tomanInDom: (document.body.innerHTML.match(/تومان/g) || []).length,
    tabularNums: document.querySelectorAll('.tabular-nums').length,
    firstTabular: (document.querySelector('.tabular-nums').textContent || '').replace(/\s+/g, ' ').trim(),
    bareTabularIsThePeg: (document.querySelector('.tabular-nums').textContent || '').includes('دلار'),
    specPriceClass: document.querySelectorAll('.text-spec-currency-price').length,
    priceId: document.querySelectorAll('#price').length,
  }));
  // 13 in this reduced fixture, 46 on the live page. The point is only that
  // the word identifies many elements, so it cannot anchor a selector.
  assert('تومان is NOT a unique anchor here', azCounts.tomanInDom > 5, true);
  assert('.tabular-nums matches exactly two', azCounts.tabularNums, 2);
  assert('...and the FIRST is the (۱دلار) peg', azCounts.bareTabularIsThePeg, true);
  assert('the bare class would read the peg', azCounts.firstTabular, '(۱دلار)');
  // TRAP 2 — the price class is shared with the volume cell, so the adapter
  // reaches the price through the IRT symbol cell's sibling instead.
  assert('the price class also matches the volume cell', azCounts.specPriceClass, 2);
  assert('#price is unique', azCounts.priceId, 1);

  const azTags = await p16.evaluate(() => {
    const info = (key) => ({
      probe: document.querySelectorAll('[data-probe="' + key + '"]').length,
      monitor: document.querySelectorAll('[data-monitor]').length,
    });
    return { hero: info('hero'), card: info('card'), sidebar: info('sidebar') };
  });
  assert('hero probes once', azTags.hero.probe, 1);
  assert('card probes once', azTags.card.probe, 1);
  assert('sidebar probes once', azTags.sidebar.probe, 1);
  assert('nothing is tagged for element capture', azTags.hero.monitor, 0);

  const azVis = await p16.evaluate(probeVisibility, { selectors: {
    hero: '[data-probe="hero"]',
    card: '[data-probe="card"]',
    ticker: '[data-probe="ticker"]',
    sidebar: '[data-probe="sidebar"]',
    marketTable: '[data-probe="marketTable"]',
  } });
  assert('every probed price is visible', ['hero', 'card', 'ticker', 'sidebar', 'marketTable'].every((k) => azVis[k].visible), true);

  const azReport = buildReport({
    scrape: {
      exchangeId: 'arzinja', ready: az.ready, feedLive: az.feedLive, durationMs: 11000,
      probes: Object.fromEntries(az.probes.map((x) => [x.key, { label: x.label, raw: x.raw, primary: !!x.primary, visible: true, reason: 'visible' }])),
      flashed: { detected: false },
    },
    api: null, expect: 'hidden', unitLabel: 'تومان',
  });
  console.log('  ' + azReport.description);
  assert('shown price is a violation', azReport.state, 'violation');
  assert('persian digits give the right number', azReport.price.value, 268505);
  assert('unit is tomans', azReport.price.unit, 'تومان');
  // api is null by decision, so no cross-check sentence may be claimed.
  assert('does not claim an API cross-check', azReport.description.includes('API عمومی'), false);
  await p16.close();

  // Blank the hero only: four locations still disclose the price.
  const p17 = await browser.newPage({ locale: 'fa-IR', viewport: { width: 1440, height: 1200 } });
  await p17.setContent(azHtml.replace('>۲۶۸,۵۰۵ تومان</span>', '>—</span>'), { waitUntil: 'domcontentloaded' });
  const az17 = await p17.evaluate(arzinja.probeInPage, { coin: arzinja.coin });
  const az17v = Object.fromEntries(az17.probes.map((x) => [x.key, x.raw]));
  assert('the blanked hero reads nothing', az17v.hero, null);
  assert('...and does not fall through to the peg', az17v.hero === '۱', false);
  assert('the card still discloses the price', az17v.card, '۲۶۸,۵۰۵');
  const az17Report = buildReport({
    scrape: {
      exchangeId: 'arzinja', ready: az17.ready, feedLive: az17.feedLive, durationMs: 11000,
      probes: Object.fromEntries(az17.probes.map((x) => [x.key, { label: x.label, raw: x.raw, primary: !!x.primary, visible: true, reason: 'visible' }])),
      flashed: { detected: false },
    },
    api: null, expect: 'hidden', unitLabel: 'تومان',
  });
  assert('four surviving sites are still a violation', az17Report.state, 'violation');
  await p17.close();

  /* ---------- iranexchange: one rate, two digit formats, and an absent row ---------- */

  // The live site does not list tether in its market table at all — only the
  // conversion widget carries the rate. This fixture reproduces BOTH shapes,
  // because the row did exist in an earlier capture and must work when it
  // returns without ever being required.
  const ieHtml = fs.readFileSync(path.join(__dirname, 'fixtures', 'iranexchange.html'), 'utf8');

  console.log('\n=== iranexchange: Persian+U+066C vs Latin+comma, and an absent row ===');
  const iranexchange = require('../src/exchanges/iranexchange');
  const p18 = await browser.newPage({ locale: 'fa-IR', viewport: { width: 1440, height: 1200 } });
  await p18.setContent(ieHtml, { waitUntil: 'domcontentloaded' });
  const ie = await p18.evaluate(iranexchange.probeInPage, { coin: iranexchange.coin });
  const iev = Object.fromEntries(ie.probes.map((x) => [x.key, x.raw]));
  console.log('  ' + JSON.stringify(iev));

  assert('both locations found', ie.probes.length, 2);
  // The two surfaces use different digit scripts AND different separators, and
  // they do not agree on the number. Both are disclosures.
  assert('widget reads persian digits with U+066C', iev.widget, '۲۶۸٬۷۵۰');
  assert('table reads latin digits with a comma', iev.table, '268,800');
  assert('...and the two surfaces genuinely disagree', iev.widget !== iev.table, true);

  const ieRead = Object.values(iev);
  assert('never reads the USDS card', ieRead.includes('۲۶۹٬۲۶۰'), false);
  assert('never reads the GRAM card', ieRead.includes('۴۰۸٬۴۸۲'), false);
  assert('never reads the BTC row', ieRead.includes('22,781,878,299'), false);
  assert('never reads the USDC peg quote', ieRead.includes('268,689'), false);
  assert('never reads the mobile-only third copy', ieRead.length, 2);

  // The structural facts the table probe rests on, measured and pinned.
  const ieCounts = await p18.evaluate(() => {
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const row = document.querySelector('a[aria-label="USDT"]').closest('tr');
    const tds = Array.from(row.children);
    const headerText = Array.from(document.querySelectorAll('thead th')).map((t) => norm(t.textContent));
    return {
      cells: tds.length,
      buyHeader: headerText[1],
      sellHeader: headerText[2],
      // The mobile cell is the ONLY price cell whose <a> lacks an aria-label.
      priceCellsWithAria: row.querySelectorAll('a[aria-label="USDT"] span').length,
      mobileCellAria: !!tds[4].querySelector('a[aria-label]'),
      tomanInDom: (document.body.innerHTML.match(/تومان/g) || []).length,
    };
  });
  assert('the row has six cells', ieCounts.cells, 6);
  assert('children[1] is the buy-price column', ieCounts.buyHeader, 'قیمت خرید');
  assert('children[2] is the sell-price column', ieCounts.sellHeader, 'قیمت فروش');
  assert('only the two desktop cells carry aria-label', ieCounts.priceCellsWithAria > 0 && ieCounts.mobileCellAria, false);
  // «تومان» is worthless as an anchor on this page (111 times live, 20 even in
  // this reduced fixture); pinned so nobody tries to select on it.
  assert('تومان is not a usable anchor here', ieCounts.tomanInDom > 10, true);

  // The mobile-only third copy must be reported as not rendered — it is in the
  // DOM and in textContent, but sm:hidden means display:none at our viewport.
  const ieHidden = await p18.evaluate(() => {
    const row = document.querySelector('a[aria-label="USDT"]').closest('tr');
    return getComputedStyle(row.children[4]).display;
  });
  assert('the mobile-only price cell is display:none', ieHidden, 'none');

  const ieTags = await p18.evaluate(() => {
    const info = (key) => ({
      probe: document.querySelectorAll('[data-probe="' + key + '"]').length,
      monitor: document.querySelectorAll('[data-monitor]').length,
    });
    return { widget: info('widget'), table: info('table') };
  });
  assert('widget probes once', ieTags.widget.probe, 1);
  assert('table probes once', ieTags.table.probe, 1);
  assert('nothing is tagged for element capture', ieTags.table.monitor, 0);

  const ieVis = await p18.evaluate(probeVisibility, { selectors: { widget: '[data-probe="widget"]', table: '[data-probe="table"]' } });
  assert('the widget rate is visible', ieVis.widget.visible, true);
  assert('the table price is visible', ieVis.table.visible, true);

  const ieReport = buildReport({
    scrape: {
      exchangeId: 'iranexchange', ready: ie.ready, feedLive: ie.feedLive, durationMs: 11000,
      probes: Object.fromEntries(ie.probes.map((x) => [x.key, { label: x.label, raw: x.raw, primary: !!x.primary, visible: true, reason: 'visible' }])),
      flashed: { detected: false },
    },
    api: null, expect: 'hidden', unitLabel: 'تومان',
  });
  console.log('  ' + ieReport.description);
  assert('shown price is a violation', ieReport.state, 'violation');
  assert('unit is tomans', ieReport.price.unit, 'تومان');
  assert('no API claim when there is no API', ieReport.description.includes('API عمومی'), false);
  await p18.close();

  // THE LIVE SHAPE. This is what the real site serves: no tether row in the
  // table at all. The widget alone must still decide the verdict, and the
  // missing row must not be mistaken for a page that failed to load.
  const p19 = await browser.newPage({ locale: 'fa-IR', viewport: { width: 1440, height: 1200 } });
  await p19.setContent(ieHtml.replace(/<a aria-label="USDT"/g, '<a aria-label="TETHERGONE"').replace(/>تتر</g, '>تتر-حذف-شده<'), { waitUntil: 'domcontentloaded' });
  const ie19 = await p19.evaluate(iranexchange.probeInPage, { coin: iranexchange.coin });
  const ie19v = Object.fromEntries(ie19.probes.map((x) => [x.key, x.raw]));
  console.log('  with the tether row absent: ' + JSON.stringify(ie19v));
  assert('the page is still ready without the table row', ie19.ready, true);
  assert('the widget alone still reads the rate', ie19v.widget, '۲۶۸٬۷۵۰');
  assert('the absent row simply reports nothing', ie19v.table, null);
  const ie19Report = buildReport({
    scrape: {
      exchangeId: 'iranexchange', ready: ie19.ready, feedLive: ie19.feedLive, durationMs: 11000,
      probes: Object.fromEntries(ie19.probes.map((x) => [x.key, { label: x.label, raw: x.raw, primary: !!x.primary, visible: true, reason: 'visible' }])),
      flashed: { detected: false },
    },
    api: null, expect: 'hidden', unitLabel: 'تومان',
  });
  assert('the widget alone is still a violation', ie19Report.state, 'violation');
  assert('persian digits with U+066C give the right number', ie19Report.price.value, 268750);
  await p19.close();

  /* ---------- asretether: two copies, one visible, and a stale price in prose ---------- */

  // The first page here whose price exists twice on purpose: `xl:hidden` and
  // `max-xl:hidden`. Probing both and letting the visibility gate decide is the
  // whole design, so the tests have to prove the pair actually swaps.
  const atHtml = fs.readFileSync(path.join(__dirname, 'fixtures', 'asretether.html'), 'utf8');

  console.log('\n=== asretether: two responsive copies, and a stale FAQ price ===');
  const asretether = require('../src/exchanges/asretether');
  const p20 = await browser.newPage({ locale: 'fa-IR', viewport: { width: 1440, height: 1200 } });
  await p20.setContent(atHtml, { waitUntil: 'domcontentloaded' });
  const at = await p20.evaluate(asretether.probeInPage, { coin: asretether.coin });
  const atv = Object.fromEntries(at.probes.map((x) => [x.key, x.raw]));
  console.log('  ' + JSON.stringify(atv));

  assert('both copies probed', at.probes.length, 2);
  assert('copy one reads the price', atv.card1, '268,001');
  assert('copy two reads the price', atv.card2, '268,001');

  const atRead = Object.values(atv);
  assert('never reads the 24h high', atRead.includes('273,361'), false);
  assert('never reads the 24h low', atRead.includes('260,190'), false);
  // The sharpest trap on the page: Persian digits + ASCII comma + the literal
  // word تومان, i.e. exactly what this monitor's pattern accepts.
  assert('never reads the stale FAQ price', atRead.includes('۱۲۳,۹۹۵'), false);
  // Payload-only figures, including the rendered one in unformatted form.
  assert('never reads the payload price_sell', atRead.includes('265500'), false);
  assert('never reads the unformatted payload buy price', atRead.includes('268001'), false);

  // THE RESPONSIVE GUARD. At 1440px copy one is hidden and copy two is on
  // screen; at 900px they swap. Without this, "probe both" would be decorative.
  const atWide = await p20.evaluate(probeVisibility, { selectors: { card1: '[data-probe="card1"]', card2: '[data-probe="card2"]' } });
  assert('at 1440px the mobile copy is not rendered', atWide.card1.visible, false);
  // The <p> itself still computes to display:block; it is an ANCESTOR that is
  // display:none, which collapses it to a zero-size box. Same live behaviour.
  assert('...for the right reason', atWide.card1.reason, 'zero-size');
  assert('at 1440px the desktop copy is visible', atWide.card2.visible, true);

  const p21 = await browser.newPage({ locale: 'fa-IR', viewport: { width: 900, height: 1200 } });
  await p21.setContent(atHtml, { waitUntil: 'domcontentloaded' });
  await p21.evaluate(asretether.probeInPage, { coin: asretether.coin });
  const atNarrow = await p21.evaluate(probeVisibility, { selectors: { card1: '[data-probe="card1"]', card2: '[data-probe="card2"]' } });
  assert('at 900px they swap: copy one is now visible', atNarrow.card1.visible, true);
  assert('at 900px copy two is now hidden', atNarrow.card2.visible, false);
  // Either way exactly one is on screen — that invariant is the real guarantee.
  assert('exactly one copy is visible at 1440px', [atWide.card1.visible, atWide.card2.visible].filter(Boolean).length, 1);
  assert('exactly one copy is visible at 900px', [atNarrow.card1.visible, atNarrow.card2.visible].filter(Boolean).length, 1);
  await p21.close();

  // «تومان» is useless as an anchor here; pinned so nobody tries.
  const atCounts = await p20.evaluate(() => ({
    tomanInDom: (document.body.innerHTML.match(/تومان/g) || []).length,
    priceStringCount: (document.body.innerHTML.match(/268,001/g) || []).length,
    captions: Array.from(document.querySelectorAll('h3')).map((h) => h.textContent.replace(/\s+/g, ' ').trim()).filter((t) => t.indexOf('قیمت تتر به') >= 0),
  }));
  // Enough copies that the word cannot identify one element — 62 live, and the
  // <head> meta alone carries 7.
  assert('تومان is not a usable anchor here', atCounts.tomanInDom > 5, true);
  assert('the price renders exactly twice', atCounts.priceStringCount, 2);
  assert('the peg caption is a distinct near-twin', atCounts.captions.indexOf('آخرین قیمت تتر به تتر') >= 0, true);
  assert('...and never collides with the real caption', atCounts.captions.indexOf('آخرین قیمت تتر به تومان') >= 0, true);

  const atTags = await p20.evaluate(() => {
    const info = (key) => ({
      probe: document.querySelectorAll('[data-probe="' + key + '"]').length,
      monitor: document.querySelectorAll('[data-monitor]').length,
    });
    return { card1: info('card1'), card2: info('card2') };
  });
  assert('each copy probes once', atTags.card1.probe === 1 && atTags.card2.probe === 1, true);
  assert('nothing is tagged for element capture', atTags.card1.monitor, 0);

  const atReport = buildReport({
    scrape: {
      exchangeId: 'asretether', ready: at.ready, feedLive: at.feedLive, durationMs: 11000,
      probes: Object.fromEntries(at.probes.map((x, i) => [x.key, {
        label: x.label, raw: x.raw, primary: !!x.primary,
        visible: atWide[x.key].visible, reason: atWide[x.key].reason,
      }])),
      flashed: { detected: false },
    },
    api: null, expect: 'hidden', unitLabel: 'تومان',
  });
  console.log('  ' + atReport.description);
  assert('shown price is a violation', atReport.state, 'violation');
  assert('price value', atReport.price.value, 268001);
  assert('unit is tomans', atReport.price.unit, 'تومان');
  assert('no API claim when there is no API', atReport.description.includes('API عمومی'), false);
  // On the violation path diagnose returns early, so the hidden responsive
  // duplicate produces no note. Assert that explicitly rather than leaving it
  // as an untested assumption — and prove the note path separately below.
  assert('no hidden-duplicate note on the violation path', atReport.description.includes('نمایش داده نمی‌شود'), false);

  // The case "probe both" earns its keep on: only the hidden copy holds a
  // price, so the page reads compliant — and the report must still surface the
  // value instead of dropping it.
  const atHiddenOnly = buildReport({
    scrape: {
      exchangeId: 'asretether', ready: at.ready, feedLive: at.feedLive, durationMs: 11000,
      probes: {
        card1: { label: 'قیمت تتر به تومان (نسخه موبایل)', raw: '268,001', visible: false, reason: 'not-rendered' },
        card2: { label: 'قیمت تتر به تومان', raw: null, primary: true, visible: true, reason: 'visible' },
      },
      flashed: { detected: false },
    },
    api: null, expect: 'hidden', unitLabel: 'تومان',
  });
  console.log('  ' + atHiddenOnly.description);
  assert('no visible price -> compliant', atHiddenOnly.state, 'compliant');
  assert('the hidden duplicate is still reported', atHiddenOnly.description.includes('نمایش داده نمی‌شود'), true);
  await p20.close();

  /* ---------- hitobit: one price, one id, and ids that lie about themselves ---------- */

  // The simplest page so far, and the useful counter-example: a single stable id
  // cannot reach any of the decoys, so the selector does the whole job.
  const hbHtml = fs.readFileSync(path.join(__dirname, 'fixtures', 'hitobit.html'), 'utf8');

  console.log('\n=== hitobit: one span, and the decoys it cannot reach ===');
  const hitobit = require('../src/exchanges/hitobit');
  const p22 = await browser.newPage({ locale: 'fa-IR', viewport: { width: 1440, height: 1200 } });
  await p22.setContent(hbHtml, { waitUntil: 'domcontentloaded' });
  const hb = await p22.evaluate(hitobit.probeInPage, { coin: hitobit.coin });
  const hbv = Object.fromEntries(hb.probes.map((x) => [x.key, x.raw]));
  console.log('  ' + JSON.stringify(hbv));

  assert('reads the price', hbv.priceSlot, '269,033');
  assert('the id resolves to exactly one element', await p22.evaluate(() => document.querySelectorAll('#last-usdt-price').length), 1);

  const hbRead = Object.values(hbv);
  // The market table's USD cells: comma-grouped, non-zero, twelve decimals.
  assert('never reads the ETH dollar price', hbRead.includes('2,683'), false);
  assert('never reads the PAXG dollar price', hbRead.includes('4,147'), false);
  assert('never reads an abbreviated تومان value', hbRead.includes('721.90'), false);
  assert('never reads the market cap', hbRead.includes('3.30'), false);
  assert('never reads the dominance', hbRead.includes('63.69'), false);
  assert('never reads a counter', hbRead.includes('99') || hbRead.includes('151'), false);
  assert('never reads a value out of the ticker payload', hbRead.includes('267914') || hbRead.includes('267335'), false);

  // The two ids are SWAPPED on the live site. Asserted here so the fixture
  // documents their bug instead of quietly correcting it — a later reader must
  // not trust `#dominance-btc` to mean dominance.
  const hbIds = await p22.evaluate(() => ({
    dominance: (document.getElementById('dominance-btc').textContent || '').replace(/\s+/g, ' ').trim(),
    marketCap: (document.getElementById('market-cap').textContent || '').replace(/\s+/g, ' ').trim(),
  }));
  assert('the dominance id actually holds the market cap', hbIds.dominance, '$ 3.30 T');
  assert('the market-cap id actually holds the dominance', hbIds.marketCap, '% 63.69');

  // The unit is a bare TEXT NODE after the span, not an element — so there is
  // no selector for it. Asserted as a text node so nobody "fixes" it into one.
  const hbUnit = await p22.evaluate(() => {
    const el = document.querySelector('#last-usdt-price');
    const next = el.nextSibling;
    return { nodeType: next ? next.nodeType : null, text: next && next.nodeType === 3 ? next.textContent.trim() : null };
  });
  assert('the unit is a text node, not an element', hbUnit.nodeType, 3);
  assert('...and it says تومان', hbUnit.text, 'تومان');

  const hbTags = await p22.evaluate(() => {
    const p = document.querySelectorAll('[data-probe="priceSlot"]');
    const m = document.querySelectorAll('[data-monitor]');
    return { probe: p.length, monitor: m.length };
  });
  assert('probes once', hbTags.probe, 1);
  assert('nothing is tagged for element capture', hbTags.monitor, 0);

  const hbReport = buildReport({
    scrape: {
      exchangeId: 'hitobit', ready: hb.ready, feedLive: hb.feedLive, durationMs: 11000,
      probes: Object.fromEntries(hb.probes.map((x) => [x.key, { label: x.label, raw: x.raw, primary: !!x.primary, visible: true, reason: 'visible' }])),
      flashed: { detected: false },
    },
    api: null, expect: 'hidden', unitLabel: 'تومان',
  });
  console.log('  ' + hbReport.description);
  assert('shown price is a violation', hbReport.state, 'violation');
  assert('price value', hbReport.price.value, 269033);
  assert('unit is tomans', hbReport.price.unit, 'تومان');
  assert('no API claim when there is no API', hbReport.description.includes('API عمومی'), false);
  await p22.close();

  // THE TIMING BEHAVIOUR. The span ships as an en-dash placeholder and the
  // page's own script fills it about 1.5s later (measured live). Reading the
  // placeholder must produce a placeholder verdict, never a price — and never
  // a "location not found", which would be a different and wrong statement.
  const p23 = await browser.newPage({ locale: 'fa-IR', viewport: { width: 1440, height: 1200 } });
  await p23.setContent(hbHtml.replace('269,033</span>', '–</span>'), { waitUntil: 'domcontentloaded' });
  const hb23 = await p23.evaluate(hitobit.probeInPage, { coin: hitobit.coin });
  const hb23v = Object.fromEntries(hb23.probes.map((x) => [x.key, x.raw]));
  assert('the page is still ready with a placeholder', hb23.ready, true);
  assert('the placeholder is reported verbatim', hb23v.priceSlot, '–');
  const hb23Report = buildReport({
    scrape: {
      exchangeId: 'hitobit', ready: hb23.ready, feedLive: hb23.feedLive, durationMs: 11000,
      probes: Object.fromEntries(hb23.probes.map((x) => [x.key, { label: x.label, raw: x.raw, primary: !!x.primary, visible: true, reason: 'visible' }])),
      flashed: { detected: false },
    },
    api: null, expect: 'hidden', unitLabel: 'تومان',
  });
  console.log('  ' + hb23Report.description);
  assert('a placeholder is compliant', hb23Report.state, 'compliant');
  assert('...explained as a placeholder', hb23Report.description.includes('خط تیره'), true);
  assert('...not as a missing location', hb23Report.description.includes('پیدا نشد'), false);
  await p23.close();

  /* ---------- eterex: four locations, two digit systems, gradient-painted hero ---------- */

  // The hero price is painted by a gradient clipped to the glyphs: transparent
  // fill, live background-image. A captured DOM shows the gradient as EMPTY,
  // which reads as though the digits were hidden. They are not.
  const etHtml = fs.readFileSync(path.join(__dirname, 'fixtures', 'eterex.html'), 'utf8');

  console.log('\n=== eterex: two digit systems, and a price painted by a gradient ===');
  const eterex = require('../src/exchanges/eterex');
  const p24 = await browser.newPage({ locale: 'fa-IR', viewport: { width: 1440, height: 1200 } });
  await p24.setContent(etHtml, { waitUntil: 'domcontentloaded' });
  const et = await p24.evaluate(eterex.probeInPage, { coin: eterex.coin });
  const etv = Object.fromEntries(et.probes.map((x) => [x.key, x.raw]));
  console.log('  ' + JSON.stringify(etv));

  assert('all four locations found', et.probes.length, 4);
  // BOTH digit systems are live on this one page — verified against the live
  // site, not just the fixture.
  assert('hero reads latin digits', etv.hero, '268,400');
  assert('input reads latin digits', etv.input, '268,400');
  assert('the rate row reads persian digits with U+066C', etv.rate, '۲۶۸٬۴۰۰');
  assert('the stat reads persian digits with U+066C', etv.stat, '۲۶۸٬۴۰۰');

  const etRead = Object.values(etv);
  assert('never reads the dollar price', etRead.includes('1.00'), false);
  assert('never reads a quantity', etRead.includes('1'), false);
  assert('never reads the 0.02% fee', etRead.includes('0.02'), false);
  assert('never reads a gradient step number', etRead.includes('۴'), false);

  // THE CLASS COLLISION. The hero's `1` and its `268,400` carry byte-identical
  // class lists, so a class-based selector for the price also matches the
  // quantity. Pinned so nobody writes one later.
  const etCounts = await p24.evaluate(() => {
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const priceSpan = Array.from(document.querySelectorAll('span')).find((s) => norm(s.textContent) === '268,400');
    const qtySpan = Array.from(document.querySelectorAll('span')).find((s) => norm(s.textContent) === '1' && s.className === (priceSpan ? priceSpan.className : ''));
    return {
      priceClass: priceSpan ? priceSpan.className : null,
      identicalClassExists: !!qtySpan,
      tomanInDom: (document.body.innerHTML.match(/تومان/g) || []).length,
      // The hero paint mechanism, recorded so the finding is not lost.
      heroPaint: (() => {
        const cs = getComputedStyle(priceSpan);
        return { color: cs.color, fill: cs.webkitTextFillColor, bg: cs.backgroundImage.slice(0, 60), clip: cs.backgroundClip };
      })(),
      // The shape pairing that actually identifies the hero price.
      shapeMatches: Array.from(document.querySelectorAll('span')).filter((s) => /^\d{1,3}(,\d{3})+$/.test(norm(s.textContent)) && s.nextElementSibling && norm(s.nextElementSibling.textContent) === 'تومان').length,
    };
  });
  assert('the hero quantity shares the price class list exactly', etCounts.identicalClassExists, true);
  assert('...so class selection would be ambiguous', etCounts.priceClass.length > 0, true);
  // The pairing (comma-grouped number + following «تومان» sibling) occurs once.
  assert('the shape anchor is unique', etCounts.shapeMatches, 1);
  // Three here, four on the live page — enough either way to prove the word
  // cannot identify a single element.
  assert('تومان is not a usable anchor here', etCounts.tomanInDom >= 3, true);
  // The paint mechanism: transparent FILL, gradient BACKGROUND, clipped to text.
  assert('the hero fill is transparent', etCounts.heroPaint.fill, 'rgba(0, 0, 0, 0)');
  assert('...but it is painted by a background', etCounts.heroPaint.bg.includes('gradient'), true);
  assert('...clipped to the text', etCounts.heroPaint.clip, 'text');

  const etTags = await p24.evaluate(() => {
    const info = (key) => ({
      probe: document.querySelectorAll('[data-probe="' + key + '"]').length,
      monitor: document.querySelectorAll('[data-monitor]').length,
    });
    return { hero: info('hero'), rate: info('rate'), stat: info('stat'), input: info('input') };
  });
  assert('hero probes once', etTags.hero.probe, 1);
  assert('rate probes once', etTags.rate.probe, 1);
  assert('stat probes once', etTags.stat.probe, 1);
  // The input is probed but never photographed. It no longer has to be, because
  // the capture is the whole page — but the reason it used to be excluded still
  // holds and is worth keeping: an <input>'s innerText is empty by construction,
  // so a crop of it could never contain the value.
  assert('the input is probed once', etTags.input.probe, 1);
  assert('nothing is tagged for element capture', etTags.hero.monitor, 0);

  const etReport = buildReport({
    scrape: {
      exchangeId: 'eterex', ready: et.ready, feedLive: et.feedLive, durationMs: 11000,
      probes: Object.fromEntries(et.probes.map((x) => [x.key, { label: x.label, raw: x.raw, primary: !!x.primary, visible: true, reason: 'visible' }])),
      flashed: { detected: false },
    },
    api: null, expect: 'hidden', unitLabel: 'تومان',
  });
  console.log('  ' + etReport.description);
  assert('shown price is a violation', etReport.state, 'violation');
  assert('price value', etReport.price.value, 268400);
  assert('unit is tomans', etReport.price.unit, 'تومان');
  assert('no API claim when there is no API', etReport.description.includes('API عمومی'), false);
  await p24.close();

  /* ---------- a slot that says NaN is not a missing slot ---------- */

  // asretether renders the literal text `NaN` when its feed has no Toman pair.
  // Finding the price node by CONTENT produced no probe at all, so the page read
  // «نامشخص». It must read compliant, with `NaN` visible as evidence.
  console.log('\n=== asretether: NaN in the price slot is compliant, not unknown ===');
  const atHtmlBase = fs.readFileSync(path.join(__dirname, 'fixtures', 'asretether.html'), 'utf8');

  const slotCase = async (label, slotText, expectState) => {
    const page = await browser.newPage({ locale: 'fa-IR', viewport: { width: 1440, height: 1200 } });
    await page.setContent(atHtmlBase.replace(/>268,001</g, `>${slotText}<`), { waitUntil: 'domcontentloaded' });
    const snap = await page.evaluate(asretether.probeInPage, { coin: asretether.coin });
    const vals = snap.probes.map((x) => x.raw);
    const ok = snap.probes.length > 0 && vals.every((v) => v === slotText);
    assert(`${label}: the slot is still probed`, ok, true);
    const r = buildReport({
      scrape: { exchangeId: 'asretether', ready: snap.ready, feedLive: snap.feedLive, httpStatus: 200, probes: Object.fromEntries(snap.probes.map((x) => [x.key, { label: x.label, raw: x.raw, primary: !!x.primary, visible: true, reason: 'visible' }])), flashed: { detected: false }, screenshots: [] },
      api: null, expect: 'hidden', unitLabel: 'تومان',
    });
    assert(`${label}: verdict is ${expectState}`, r.state, expectState);
    await page.close();
    return r;
  };

  {
    const r = await slotCase('NaN', 'NaN', 'compliant');
    assert('NaN is explained, not blank', r.description.includes('مقدار نامعتبر'), true);
  }
  await slotCase('an em dash', '—', 'compliant');
  await slotCase('a real price', '268,001', 'violation');
  // The 24h high/low on that page are comma-grouped and inside the monitored
  // band; they must stay out of the verdict whatever the slot holds.
  {
    const page = await browser.newPage({ locale: 'fa-IR', viewport: { width: 1440, height: 1200 } });
    await page.setContent(atHtmlBase.replace(/>268,001</g, '>NaN<'), { waitUntil: 'domcontentloaded' });
    const snap = await page.evaluate(asretether.probeInPage, { coin: asretether.coin });
    const r = buildReport({
      scrape: { exchangeId: 'asretether', ready: snap.ready, feedLive: snap.feedLive, httpStatus: 200, probes: Object.fromEntries(snap.probes.map((x) => [x.key, { label: x.label, raw: x.raw, primary: !!x.primary, visible: true, reason: 'visible' }])), flashed: { detected: false }, screenshots: [] },
      api: null, expect: 'hidden', unitLabel: 'تومان',
    });
    const read = snap.probes.map((x) => String(x.raw));
    assert('the 24h high is never read', read.includes('275,338'), false);
    assert('the 24h low is never read', read.includes('261,278'), false);
    assert('NaN still yields compliant', r.state, 'compliant');
    await page.close();
  }

  /* ---------- eterex backup page: a zero is only believed on a live feed ---------- */

  console.log('\n=== eterex: the backup market page, and when its zero is trusted ===');
  const etMarketHtml = fs.readFileSync(path.join(__dirname, 'fixtures', 'eterex-market.html'), 'utf8');
  const fb = eterex.fallback; // eterex adapter already required above

  // CASE A — the grid is alive: BTC and ETH carry real تومان rates.
  {
    const p = await browser.newPage({ locale: 'fa-IR', viewport: { width: 1440, height: 1200 } });
    await p.setContent(etMarketHtml, { waitUntil: 'domcontentloaded' });
    const snap = await p.evaluate(fb.probeInPage, { coin: 'USDT' });
    const alive = await p.evaluate(fb.feedLooksAlive);
    assert('backup probe finds the row', snap.ready, true);
    assert('...and reads the تومان cell', snap.probes[0].raw, '0');
    assert('a live feed is trusted', alive, true);
    const r = buildReport({
      scrape: { exchangeId: 'eterex', ready: snap.ready, feedLive: snap.feedLive, httpStatus: 200, usedFallback: { url: fb.url, label: fb.label }, probes: Object.fromEntries(snap.probes.map((x) => [x.key, { label: x.label, raw: x.raw, primary: !!x.primary, visible: true, reason: 'visible' }])), flashed: { detected: false }, screenshots: [] },
      api: null, expect: 'hidden', unitLabel: 'تومان',
    });
    assert('a trusted zero on a live feed is compliant', r.state, 'compliant');
    assert('the report names the surface it read', r.description.includes(fb.label), true);
    await p.close();
  }

  // CASE B — every row zeroed, i.e. the site's own feed is dead. This is the
  // case the trust gate exists for: the grid would read as «compliant» and be
  // wrong, because nothing was actually withheld.
  {
    const dead = etMarketHtml.replace(/18,024,500/g, '0').replace(/533,118/g, '0').replace(/\$67,240/g, '$0').replace(/\$1,986/g, '$0');
    const p = await browser.newPage({ locale: 'fa-IR', viewport: { width: 1440, height: 1200 } });
    await p.setContent(dead, { waitUntil: 'domcontentloaded' });
    const snap = await p.evaluate(fb.probeInPage, { coin: 'USDT' });
    const alive = await p.evaluate(fb.feedLooksAlive);
    assert('a zeroed grid still parses the row', snap.probes[0].raw, '0');
    assert('...but the dead feed is NOT trusted', alive, false);
    await p.close();
  }

  // The probe must never confuse the dollar column or the change badge for the
  // تومان reading — including when the تومان cell is absent entirely.
  {
    const p = await browser.newPage({ locale: 'fa-IR', viewport: { width: 1440, height: 1200 } });
    await p.setContent(etMarketHtml.replace('<span class="ltr text-center text-[15px] font-bold tabular-nums text-text-2">0</span>', ''), { waitUntil: 'domcontentloaded' });
    const snap = await p.evaluate(fb.probeInPage, { coin: 'USDT' });
    assert('with no تومان cell the probe refuses to guess', snap.ready, false);
    await p.close();
  }

  /* ---------- bitpin: an empty price slot, and a change that looks like one ---------- */

  // The fixture reproduces the paste that started this investigation: the
  // ticker's price span is EMPTY and the change reads ۰. That is the page
  // complying with the order — but the probe used to fall through to the
  // parenthesised change and report "۰" as the tether price.
  const bitpinHtml = fs.readFileSync(path.join(__dirname, 'fixtures', 'bitpin.html'), 'utf8');
  const bitpin = require('../src/exchanges/bitpin');

  const bpProbe = async (html) => {
    const p = await browser.newPage({ locale: 'fa-IR', viewport: { width: 1440, height: 1200 } });
    await p.setContent(html, { waitUntil: 'domcontentloaded' });
    const snap = await p.evaluate(bitpin.probeInPage, { coin: bitpin.coin });
    // Read the tags here, while the page still exists — the probe clears them
    // at the start of every run, so they only exist between two calls.
    const tags = await p.evaluate(() => ({
      ticker: document.querySelectorAll('[data-probe="ticker"]').length,
      row: document.querySelectorAll('[data-probe="row"]').length,
      monitor: document.querySelectorAll('[data-monitor]').length,
    }));
    const out = { snap, tags, byKey: Object.fromEntries(snap.probes.map((x) => [x.key, x.raw])) };
    await p.close();
    return out;
  };
  // The paste is the regression case: the slot is present and holds nothing.
  const withPrice = (slot, change) =>
    bitpinHtml
      .replace('<span><!--price--></span>', `<span>${slot}</span>`)
      .replace('(<span class="text-green" dir="ltr">۰</span>)', `(${change})`);

  console.log('\n=== bitpin: the pasted ticker, verbatim ===');
  {
    const { snap, byKey, tags } = await bpProbe(bitpinHtml);
    assert('the market table still establishes readiness', snap.ready, true);
    assert('the row reads its own slot', byKey.row, '-');
    // The regression: '' is the honest reading. '۰' is the change, and reading
    // it as the price is the bug — it also put wrong evidence in the log detail.
    assert('an empty price slot reads as empty', byKey.ticker, '');
    assert('never reads the change as the price', byKey.ticker === '۰', false);
    // '' and null must stay distinguishable: null means the surface is absent
    // from the page, '' means the surface rendered and holds no price.
    assert('an empty slot is not reported as absent', byKey.ticker === null, false);
    assert('the ticker is still probed', tags.ticker, 1);
    assert('the row is still probed', tags.row, 1);
    assert('nothing is tagged for element capture', tags.monitor, 0);

    const r = buildReport({
      scrape: {
        exchangeId: 'bitpin', ready: snap.ready, feedLive: snap.feedLive, httpStatus: 200,
        probes: Object.fromEntries(snap.probes.map((x) => [x.key, { label: x.label, raw: x.raw, primary: !!x.primary, visible: true, reason: 'visible' }])),
        flashed: { detected: false },
      },
      api: { ok: true, price: 268080, change: 0, error: null },
      expect: 'hidden', unitLabel: 'تومان',
    });
    assert('a withheld price is compliant', r.state, 'compliant');
  }

  console.log('\n=== bitpin: the fix did not delete too much ===');
  {
    // A populated ticker must still read its price, or the adapter would report
    // every flash on this exchange as compliance.
    const { byKey } = await bpProbe(withPrice('۲۶۸,۰۸۰', '<span class="text-green" dir="ltr">+۲.۲۶</span>'));
    assert('a populated ticker reads its price', byKey.ticker, '۲۶۸,۰۸۰');
    // Same price, negative change: shape alone would read the change.
    const neg = await bpProbe(withPrice('۲۶۸,۰۸۰', '<span class="text-red" dir="ltr">-۲.۲۶</span>'));
    assert('a negative change is never the price', neg.byKey.ticker, '۲۶۸,۰۸۰');
    // An empty slot with a signed change must stay empty.
    const dashed = await bpProbe(withPrice('۲۶۸,۰۸۰', '<span class="text-red" dir="ltr">-۲.۲۶</span>').replace('<span>۲۶۸,۰۸۰</span>', '<span>-</span>'));
    assert('a dash price is a price, not a change', dashed.byKey.ticker, '-');
    const emptySigned = await bpProbe(withPrice('', '<span class="text-red" dir="ltr">-۲.۲۶</span>'));
    assert('a signed change never fills an empty price', emptySigned.byKey.ticker, '');
    assert('nor does it become the price', emptySigned.byKey.ticker === '۲.۲۶', false);
    // A ticker with no change slot at all still resolves to the last slot.
    const noChange = await bpProbe(
      bitpinHtml.replace('<span>(<span class="text-green" dir="ltr">۰</span>)</span>\n    </a>', '</a>')
        .replace('<span><!--price--></span>', '<span>۲۶۸,۰۸۰</span>')
    );
    assert('a ticker with no change still reads its price', noChange.byKey.ticker, '۲۶۸,۰۸۰');
    // The neighbour coin in the same strip must never be read.
    const neighbour = await bpProbe(withPrice('۲۶۸,۰۸۰', '<span class="text-green" dir="ltr">+۲.۲۶</span>'));
    assert('never reads the neighbouring BTC price', Object.values(neighbour.byKey).includes('۲٬۹۹۴٬۰۰۰٬۰۰۰'), false);
  }

  console.log('\n=== bitpin: «نامشخص» must say which surfaces it looked at ===');
  {
    // The page loaded (200) but the market table never rendered, so the probe
    // never reported ready. That is what the log showed. The report has to name
    // the surfaces instead of printing a bare sentence.
    const { snap } = await bpProbe(
      bitpinHtml.replace(/<table[\s\S]*?<\/table>/, '<div class="skeleton h-96"></div>')
    );
    assert('no table means not ready', snap.ready, false);
    const r = buildReport({
      scrape: {
        exchangeId: 'bitpin', ready: false, feedLive: false, httpStatus: 200,
        probes: Object.fromEntries(snap.probes.map((x) => [x.key, { label: x.label, raw: x.raw, primary: !!x.primary, visible: true, reason: 'visible' }])),
        flashed: { detected: false },
      },
      api: { ok: true, price: 268080, change: 0, error: null },
      expect: 'hidden', unitLabel: 'تومان',
    });
    console.log('  ' + r.title);
    console.log('  ' + r.description);
    assert('still unknown, never compliant', r.state, 'unknown');
    assert('...with the feed_stalled reason', r.reasonCode, 'feed_stalled');
    // The per-surface readings live in `probes` (the detail page renders them
    // as rows); the old `detail` string that repeated them is gone.
    assert('the surfaces ride in the probes', Object.keys(r.probes).length, 2);
    assert('the market table is carried as absent', r.probes.row.raw == null, true);
    assert('the ticker is carried as empty', r.probes.ticker.raw, '');
    // The whole point of the readiness budget: a table that renders LATE must
    // not be reported as absent. Assert the adapter asks for the extra wait.
    assert('bitpin declares a readiness ceiling', bitpin.readyTimeoutMs > 0, true);
    assert('readiness is still gated on the table alone', bitpin.probeInPage.toString().includes('ready: !!row'), true);
  }

  /* ---------- ramzinex: the price it is publishing ---------- */

  const ramzinexHtml = fs.readFileSync(path.join(__dirname, 'fixtures', 'ramzinex.html'), 'utf8');
  const ramzinex = require('../src/exchanges/ramzinex');

  const rxProbe = async (html) => {
    const p = await browser.newPage({ locale: 'fa-IR', viewport: { width: 1440, height: 1200 } });
    await p.setContent(html, { waitUntil: 'domcontentloaded' });
    const snap = await p.evaluate(ramzinex.probeInPage, { coin: ramzinex.coin, marketId: ramzinex.marketId });
    const tags = await p.evaluate(() => ({
      headline: document.querySelectorAll('[data-probe="headline"]').length,
      carousel: document.querySelectorAll('[data-probe="carousel"]').length,
      monitor: document.querySelectorAll('[data-monitor]').length,
    }));
    await p.close();
    return { snap, tags, byKey: Object.fromEntries(snap.probes.map((x) => [x.key, x.raw])) };
  };

  console.log('\n=== ramzinex: the pasted overview block, verbatim ===');
  {
    const { snap, byKey, tags } = await rxProbe(ramzinexHtml);
    assert('the overview block establishes readiness', snap.ready, true);
    assert('the strip counts as a live feed', snap.feedLive, true);
    // This is the assertion the whole investigation turned on: the pasted DOM's
    // caption is a MuiTypography-caption span inside div.flex-row-start-center,
    // and the value is the first non-empty <p> — both already correct in the
    // adapter, which is why the missed reading was timing and not selectors.
    assert('the headline reads the pasted value', byKey.headline, '2,678,500');
    assert('the carousel reads the tether chip', byKey.carousel, '2,678,500');
    // The neighbours in the strip must never be read as this market's price.
    assert('never reads the neighbouring BTC price', byKey.headline === '6,120,400,000' || byKey.carousel === '6,120,400,000', false);
    assert('never reads the 24h high', Object.values(byKey).includes('2,620,000'), false);
    assert('never reads the 24h low', Object.values(byKey).includes('2,594,000'), false);
    assert('headline is tagged once', tags.headline, 1);
    assert('carousel is tagged once', tags.carousel, 1);
    assert('nothing is tagged for element capture', tags.monitor, 0);

    // The title channel. It rides up as its own field and must never become a
    // probe: `sampleOnce` builds `any` from `snap.probes` alone.
    assert('the page title is captured', snap.pageTitle, '2,678,500 IRR | رمزینکس تریدر | تتر');
    assert('the title is NOT a probe key', snap.probes.some((x) => x.key === 'pageTitle'), false);
    assert('...and no probe key is derived from it', snap.probes.length, 2);
  }

  console.log('\n=== ramzinex: a compliant page, and a page that never rendered ===');
  {
    // Complying: the block is there and holds no price.
    const blank = ramzinexHtml.replace('<p>2,678,500</p>', '<p>-</p>')
      .replace('<span>2,678,500</span>', '<span>-</span>')
      .replace('<title>2,678,500 IRR | رمزینکس تریدر | تتر</title>', '<title>رمزینکس تریدر | تتر</title>');
    const { snap, byKey } = await rxProbe(blank);
    assert('a blanked headline is still ready', snap.ready, true);
    assert('...and reads as blank, not as a price', byKey.headline, '-');
    const r = buildReport({
      scrape: {
        exchangeId: 'ramzinex', ready: snap.ready, feedLive: snap.feedLive, httpStatus: 200,
        pageTitle: snap.pageTitle,
        probes: Object.fromEntries(snap.probes.map((x) => [x.key, { label: x.label, raw: x.raw, primary: !!x.primary, visible: true, reason: 'visible' }])),
        flashed: { detected: false },
      },
      api: { ok: true, price: 267850, change: 0, error: null },
      expect: 'hidden', unitLabel: 'ریال',
    });
    assert('and it is compliant', r.state, 'compliant');
    assert('...with no title finding, because the title has no number', r.titlePrice, null);
    assert('...and no title sentence', r.description.includes('سربرگ مرورگر'), false);

    // The block never rendered. The title still has to be reported: that is
    // exactly the case where the page is hardest to read and most worth naming.
    const empty = '<!doctype html><html><head><title>2,678,500 IRR | رمزینکس تریدر | تتر</title></head><body></body></html>';
    const miss = await rxProbe(empty);
    assert('no overview means not ready', miss.snap.ready, false);
    assert('...but the title is still read', miss.snap.pageTitle, '2,678,500 IRR | رمزینکس تریدر | تتر');
    const r2 = buildReport({
      scrape: {
        exchangeId: 'ramzinex', ready: miss.snap.ready, feedLive: false, httpStatus: 200,
        pageTitle: miss.snap.pageTitle,
        probes: Object.fromEntries(miss.snap.probes.map((x) => [x.key, { label: x.label, raw: x.raw, primary: !!x.primary, visible: true, reason: 'visible' }])),
        flashed: { detected: false },
      },
      api: null, expect: 'hidden', unitLabel: 'ریال',
    });
    assert('an unreadable page stays unknown', r2.state, 'unknown');
    assert('...while still naming the title', r2.titlePrice.value, 2678500);
    assert('...and saying so in the description', r2.description.includes('سربرگ مرورگر'), true);
    // Declared, and inside the arithmetic the plan demands.
    assert('ramzinex declares a readiness ceiling', ramzinex.readyTimeoutMs > 0, true);
    const config = require('../src/config');
    const budget = config.settleMs + ramzinex.readyTimeoutMs + 2000;
    assert('...and the whole check still fits the ceiling', budget < config.checkTimeoutMs, true);
  }

  /* ---------- the dashboard itself: public/*.css and public/*.js ----------
     Nothing tested these before, which is why four empty boxes shipped and why
     `httpStatus` was missing from the expanded log row. Both are asserted here
     against the real stylesheet and the real page scripts. */

  console.log('\n=== exchange.html: hidden must mean hidden ===');
  {
    const p = await browser.newPage({ locale: 'fa-IR', viewport: { width: 1440, height: 1200 } });
    // Served from the real file, so the assertions below run against the
    // stylesheet this app actually ships.
    await p.goto(`${publicBase}/exchange.html`, { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(250);

    const displayOf = async (id) =>
      p.evaluate((elId) => getComputedStyle(document.getElementById(elId)).display, id);

    // These four all set `display` in the stylesheet, which beat the UA
    // `[hidden]` rule. `el.hidden = true` therefore rendered them visibly empty.
    for (const id of ['flashNote', 'priceBox', 'metaFallback', 'refreshNote', 'shotPanel']) {
      const shown = await displayOf(id);
      assert(`${id} is hidden by default`, shown, 'none');
      const revealed = await p.evaluate((elId) => {
        const el = document.getElementById(elId);
        el.hidden = false;
        return getComputedStyle(el).display;
      }, id);
      assert(`${id} appears when unhidden`, revealed !== 'none', true);
      await p.evaluate((elId) => { document.getElementById(elId).hidden = true; }, id);
      assert(`${id} hides again`, await displayOf(id), 'none');
    }

    // The fix must be global, not a per-selector patch: any element at all.
    assert('a bare [hidden] element is hidden too',
      await p.evaluate(() => {
        const el = document.createElement('div');
        el.hidden = true;
        el.style.display = 'flex';
        document.body.appendChild(el);
        return getComputedStyle(el).display;
      }), 'none');
    await p.close();
  }

  console.log('\n=== the theme switch ===');
  {
    const p = await browser.newPage({ locale: 'fa-IR', viewport: { width: 1440, height: 1200 } });
    // Seeded before any page script runs, so this really tests "applied before
    // first paint" rather than the toggle fixing it up afterwards.
    await p.addInitScript(() => {
      try {
        localStorage.setItem('usdt-monitor-theme', 'light');
      } catch (e) { /* ignore */ }
    });
    await p.goto(`${publicBase}/exchange.html`, { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(200);

    assert('the stored choice is what the page painted with',
      await p.evaluate(() => document.documentElement.dataset.theme), 'light');

    assert('the toggle is present and keyboard-reachable',
      await p.evaluate(() => {
        const b = document.getElementById('themeBtn');
        return !!(b && b.tagName === 'BUTTON' && b.getAttribute('aria-pressed') !== null);
      }), true);

    // aria-pressed names the STATE ("pressed" = light active), while the label
    // is a constant action — the pairing that survived the UX review.
    assert('aria-pressed follows the current theme',
      await p.evaluate(() => document.getElementById('themeBtn').getAttribute('aria-pressed')), 'true');
    assert('the label is the constant action, readable in either state',
      await p.evaluate(() => document.getElementById('themeBtn').textContent.trim()), 'تغییر پوسته');
    assert('...with the active theme in its accessible name',
      await p.evaluate(() => document.getElementById('themeBtn').getAttribute('aria-label').includes('روشن')), true);

    assert('clicking switches the theme',
      await p.evaluate(() => {
        document.getElementById('themeBtn').click();
        return document.documentElement.dataset.theme;
      }), 'dark');
    assert('...and persists it',
      await p.evaluate(() => localStorage.getItem('usdt-monitor-theme')), 'dark');

    // A stored choice must beat the system preference, in both directions.
    await p.emulateMedia({ colorScheme: 'light' });
    await p.waitForTimeout(150);
    assert('a stored dark choice survives a light system preference',
      await p.evaluate(() => document.documentElement.dataset.theme), 'dark');

    // With no stored choice, the system preference is followed.
    const q = await browser.newPage({ locale: 'fa-IR', viewport: { width: 1440, height: 1200 } });
    await q.emulateMedia({ colorScheme: 'light' });
    await q.goto(`${publicBase}/index.html`, { waitUntil: 'domcontentloaded' });
    await q.waitForTimeout(200);
    assert('with no stored choice the system preference wins',
      await q.evaluate(() => document.documentElement.dataset.theme), 'light');
    await q.close();
    await p.close();
  }

  console.log('\n=== logs: the expanded row must carry the HTTP status ===');
  {
    const p = await browser.newPage({ locale: 'fa-IR', viewport: { width: 1440, height: 1200 } });
    // `httpStatus` is a top-level log field, not part of `meta`, so the meta
    // flattening in detailRow never saw it and the expanded row omitted the one
    // field that separates "the price element did not render" from "the server
    // refused the page". Driven through the real page and the real renderer.
    await p.route('**/api/**', (route) => {
      const url = route.request().url();
      const payload = url.includes('/api/logs?')
        ? {
            entries: [{
              seq: 7, level: 'warn', ts: new Date().toISOString(),
              exchangeId: 'ramzinex', exchangeName: 'رمزینکس', code: 'http_503',
              message: 'سرور وضعیت ۵۰۳ برگرداند',
              url: 'https://ramzinex.ir/app/markets/11/spot/',
              httpStatus: 503, durationMs: 1234,
              meta: {
                state: 'unknown', ready: false,
                probes: { headline: { raw: null, visible: true, primary: true } },
              },
            }],
            counts: { error: 0, warn: 1, info: 0 },
            bufferedCounts: { error: 0, warn: 1, info: 0 },
            exchanges: [{ id: 'ramzinex', name: 'رمزینکس' }],
          }
        : { exchanges: [{ id: 'ramzinex', name: 'رمزینکس' }] };
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(payload),
      });
    });
    await p.goto(`${publicBase}/logs.html`, { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(700);
    assert('a log row rendered', await p.locator('.log-toggle').count() > 0, true);
    await p.click('.log-toggle');
    await p.waitForTimeout(500);

    const text = await p.evaluate(() => {
      const el = document.querySelector('.log-detail pre');
      return el ? el.textContent : null;
    });
    assert('the detail row rendered', text !== null, true);
    assert('...and carries the URL', text.includes('ramzinex.ir/app/markets/11/spot/'), true);
    assert('...and the HTTP status, worded as the row badge words it',
      text.includes('کد وضعیت سرور: 503'), true);
    // Exactly once: the status lives on the entry, not in `meta`, so the meta
    // flattening must not have added a second, differently-worded copy.
    assert('...exactly once', text.match(/کد وضعیت سرور/g).length, 1);
    await p.close();
  }

  const passed = checks.filter(Boolean).length;
  console.log(`\n${passed}/${checks.length} checks passed -> ${passed === checks.length ? 'PASS' : 'FAIL'}`);
  await closeBrowser();
  server.close();
  process.exit(passed === checks.length ? 0 : 1);
})();
