'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const sharp = require('sharp');
const config = require('./config');
const { toLatinDigits } = require('./persian');
const { probeVisibility } = require('./visibility');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const SHOTS_DIR = path.join(__dirname, '..', 'shots');
// Chromium's screenshot surface tops out around 16384px per axis and throws
// past it, so a tall page has to be clamped. 8000 CSS px comfortably inside.
const MAX_SHOT_HEIGHT = 8_000;

/* Evidence is stored as WebP, not JPEG: same page, ~40-60% smaller on disk.
 * The capture is a high-quality JPEG buffer (Playwright offers nothing else
 * worth using) that sharp re-encodes once, immediately. quality 82 keeps even
 * small on-page figures legible — that legibility is the entire point of the
 * evidence, so it is not the place to chase bytes. */
const SHOT_JPEG_QUALITY = 90;
const SHOT_WEBP_QUALITY = 82;

let browserPromise = null;
/** Which launch path actually produced the live browser. Display only. */
let resolvedChannel = null;

async function launchBrowser() {
  const opts = { headless: config.headless };
  resolvedChannel = null;
  try {
    const browser = await chromium.launch({ ...opts, channel: config.browserChannel });
    resolvedChannel = config.browserChannel;
    return browser;
  } catch {
    const browser = await chromium.launch(opts);
    resolvedChannel = 'chromium';
    return browser;
  }
}

async function getBrowser() {
  if (!browserPromise) {
    const promise = launchBrowser().then((browser) => {
      // A browser that dies later (OOM, an Edge update, a killed process)
      // poisons the cached promise: every `newContext()` after that throws and
      // the monitor would report `check_error` for all 20 exchanges, forever,
      // until a manual restart. Clearing the cache here lets the next check
      // relaunch cleanly.
      browser.on('disconnected', () => {
        if (browserPromise === promise) browserPromise = null;
      });
      return browser;
    });
    promise.catch(() => {
      if (browserPromise === promise) browserPromise = null;
    });
    browserPromise = promise;
  }
  return browserPromise;
}

async function closeBrowser() {
  if (!browserPromise) return;
  const pending = browserPromise;
  browserPromise = null;
  try {
    (await pending).close();
  } catch {
    /* already gone */
  }
}

/* ---------------- launch diagnostics ---------------- */

/**
 * Reduce an unrecognised launch error to something safe to serve.
 *
 * Playwright's message embeds the absolute browser path, the OS account name,
 * PIDs and captured browser stderr across many lines. `hint` is served on the
 * unauthenticated /api/status and rendered on the dashboard, so keep only the
 * first meaningful line and cap it. The verbose form is still reachable locally
 * via `DEBUG=pw:browser npm run doctor`.
 */
function sanitiseHint(raw) {
  const first = String(raw)
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean) || '';
  return first.length > 200 ? `${first.slice(0, 197)}…` : first;
}

/**
 * Reduce a launch failure to the one fact an operator can act on.
 *
 * Playwright reports an unusable host as a twenty-line ASCII box. That box reached
 * the log verbatim once, so nineteen exchanges reported the same unreadable wall of
 * text while the actual cause — a missing OS library — appeared nowhere an operator
 * would look. Each known cause maps to one Persian sentence plus the literal command
 * that fixes it.
 *
 * @returns {{code: string, message: string, hint: string}}
 */
function describeLaunchFailure(err) {
  const raw = (err && err.message) || String(err);
  if (/Host system is missing dependencies to run browsers/.test(raw)) {
    return {
      code: 'browser_deps_missing',
      message: 'کتابخانه‌های سیستمی مرورگر نصب نیستند',
      hint: 'sudo npx playwright install-deps',
    };
  }
  if (/Executable doesn't exist|download new browsers/.test(raw)) {
    return {
      code: 'browser_not_installed',
      message: 'مرورگر نصب نشده است',
      hint: 'npx playwright install chromium',
    };
  }
  // Unrecognised: keep Playwright's own first line rather than inventing a
  // diagnosis, but sanitised — this string reaches an HTTP response.
  return { code: 'browser_launch_failed', message: 'مرورگر اجرا نشد', hint: sanitiseHint(raw) };
}

/**
 * Launch the browser once, up front, and report whether this host can run it.
 *
 * Never throws: a browser that will not start is a finding to display, not an
 * exception to propagate. Called at startup so a misconfigured host is diagnosed in
 * seconds instead of after a full cycle of identical per-exchange errors.
 *
 * Closes the browser it opened, so running this does not leave a Chromium process
 * behind — it verifies the launch path, it does not keep a session alive.
 */
async function preflightBrowser() {
  const at = () => new Date().toISOString();
  try {
    const browser = await getBrowser();
    const health = {
      ok: true,
      checkedAt: at(),
      channel: resolvedChannel || 'chromium',
      version: browser.version(),
      code: null,
      message: null,
      hint: null,
    };
    await closeBrowser();
    return health;
  } catch (err) {
    return {
      ok: false,
      checkedAt: at(),
      channel: config.browserChannel,
      version: null,
      ...describeLaunchFailure(err),
    };
  }
}

/** Does this raw string read as a real (greater than zero) price? */
function isRealPrice(raw) {
  if (raw == null) return false;
  const t = String(raw).replace(/\s+/g, ' ').trim();
  if (t === '' || /^[-–—_.،,\s]+$/.test(t)) return false;
  if (/^-{2,}$/.test(t)) return false; // "---" as nobitex uses
  const latin = toLatinDigits(t).trim();
  if (/^[-−]/.test(latin)) return false;
  const n = Number(latin.replace(/[,\s٬]/g, '').replace(/[^\d.]/g, ''));
  return Number.isFinite(n) && n > 0;
}

/* ---------------- in-page evaluation ---------------- */

/**
 * `page.evaluate` with a deadline, because Playwright does not give it one.
 *
 * The failure this exists for is not hypothetical: رمزینکس wedges its own
 * renderer mid-navigation on roughly half of its loads, and an unbounded
 * evaluate then never settles. Left alone it consumes the entire
 * `checkTimeoutMs` budget and is reported as `check_error`, which reads like a
 * fault on this host and hides the fact that the very same page renders the
 * price moments later on a fresh load.
 *
 * A sample that loses the race is discarded by the caller, exactly like one
 * whose visibility check failed. It is never evidence.
 */
async function evaluateInPage(page, fn, arg, label) {
  let timer;
  try {
    return await Promise.race([
      page.evaluate(fn, arg),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`ارزیابی صفحه بیش از ${toLatinDigits(Math.round(config.evaluateTimeoutMs / 1000))} ثانیه طول کشید (${label})`)),
          config.evaluateTimeoutMs
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------- screenshots ---------------- */

function ensureShotsDir(exchangeId) {
  fs.mkdirSync(exchangeId ? path.join(SHOTS_DIR, exchangeId) : SHOTS_DIR, { recursive: true });
}

/** `<epochms>.webp` inside a per-exchange folder. */
const SHOT_EPOCH = /^(\d+)\.(?:webp|jpg)$/;

/**
 * Newest-first capture list for one exchange, read straight from its folder —
 * the source of truth for the /screenshots gallery (history rows do not carry
 * screenshot references; the files themselves do, via their epoch names).
 */
function listShots(exchangeId, limit = 20) {
  let names;
  try {
    names = fs.readdirSync(path.join(SHOTS_DIR, exchangeId));
  } catch {
    return [];
  }
  return names
    .map((name) => ({ name, t: Number((name.match(SHOT_EPOCH) || [])[1]) || 0 }))
    .filter((s) => s.t > 0)
    .sort((a, b) => b.t - a.t)
    .slice(0, limit)
    .map((s) => ({
      // The `file` field is deliberately slash-joined: it doubles as a URL
      // path under /shots and as a path relative to SHOTS_DIR.
      file: `${exchangeId}/${s.name}`,
      url: `/shots/${exchangeId}/${s.name}`,
      checkedAt: new Date(s.t).toISOString(),
    }));
}

/**
 * Keep only the newest `config.shotsPerExchange` captures of ONE exchange,
 * ordered by the timestamp that IS the filename. Retention is per exchange:
 * a global ceiling would let twenty busy exchanges crowd out whichever
 * exchange happens to sort first.
 */
function pruneShots(exchangeId) {
  const dir = path.join(SHOTS_DIR, exchangeId);
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  const stamped = names
    .map((f) => ({ f, t: Number((f.match(SHOT_EPOCH) || [])[1]) || 0 }))
    .sort((a, b) => a.t - b.t || a.f.localeCompare(b.f));
  let excess = stamped.length - config.shotsPerExchange;
  while (excess-- > 0) {
    try {
      fs.unlinkSync(path.join(dir, stamped.shift().f));
    } catch {
      /* ignore */
    }
  }
}

/**
 * Re-encode one captured frame to WebP and file it as this exchange's
 * evidence: `shots/<exchangeId>/<epochms>.webp`. Returns the descriptor the
 * report embeds, or null on any failure — a lost photo must never fail a
 * check that already succeeded.
 */
async function writeShot(buffer, exchangeId) {
  ensureShotsDir(exchangeId);
  const name = `${Date.now()}.webp`;
  await sharp(buffer).webp({ quality: SHOT_WEBP_QUALITY }).toFile(path.join(SHOTS_DIR, exchangeId, name));
  pruneShots(exchangeId);
  return { file: `${exchangeId}/${name}`, url: `/shots/${exchangeId}/${name}` };
}

/**
 * One-time migration of everything on disk into the per-exchange layout.
 * Legacy flat files come in two shapes — `${id}-page-${ts}.webp` and the
 * pre-WebP `${id}-page-${ts}.jpg` — and both land in `shots/<id>/<ts>.webp`
 * (JPEGs re-encoded, WebPs moved). A frame that fails to convert keeps its
 * original file; deleting evidence is never the fallback. Runs at startup
 * before the first cycle can prune.
 */
async function migrateLegacyShots() {
  ensureShotsDir();
  let names;
  try {
    names = fs.readdirSync(SHOTS_DIR, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of names.filter((e) => e.isFile() && /-page-\d+\.(?:webp|jpg)$/.test(e.name))) {
    const f = entry.name;
    const id = f.slice(0, f.indexOf('-page-'));
    const ts = (f.match(/-(\d+)\.(?:webp|jpg)$/) || [])[1];
    if (!id || !ts) continue;
    const src = path.join(SHOTS_DIR, f);
    const dst = path.join(SHOTS_DIR, id, `${ts}.webp`);
    try {
      ensureShotsDir(id);
      if (fs.existsSync(dst)) {
        fs.unlinkSync(src); // already migrated under the new name
      } else if (f.endsWith('.webp')) {
        fs.renameSync(src, dst);
      } else {
        await sharp(src).webp({ quality: SHOT_WEBP_QUALITY }).toFile(dst);
        fs.unlinkSync(src);
      }
    } catch {
      /* keep the original */
    }
  }
  try {
    for (const d of fs.readdirSync(SHOTS_DIR, { withFileTypes: true })) {
      if (d.isDirectory()) pruneShots(d.name);
    }
  } catch {
    /* ignore */
  }
}

/**
 * Viewport-only screenshot, tightly bounded. This is the frozen-page capture:
 * it goes through the compositor and needs no page JavaScript, and it is FAST
 * — which is the whole point, because it must finish inside the few seconds
 * before the page locks its main thread (the full-page walk loses that race).
 */
async function shootViewport(page) {
  return Promise.race([
    page.screenshot({ type: 'jpeg', quality: SHOT_JPEG_QUALITY }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('screenshot timeout')), 5_000)),
  ]);
}

/**
 * Screenshot buffer with NO in-page evaluation: full page if the renderer can
 * still walk itself, the viewport alone otherwise. This is the static-evidence
 * capture — the page it visits is read over HTTP precisely because it locks,
 * but that lock lands seconds later, so the full-page walk usually wins.
 */
async function shootWithoutProbe(page) {
  const bounded = (op) =>
    Promise.race([
      op,
      new Promise((_, reject) => setTimeout(() => reject(new Error('screenshot timeout')), 8_000)),
    ]);
  try {
    return await bounded(page.screenshot({ fullPage: true, type: 'jpeg', quality: SHOT_JPEG_QUALITY }));
  } catch {
    // A frozen renderer can refuse the full-page walk; the viewport alone is
    // weaker evidence, but it still shows what a visitor sees.
    return await shootViewport(page);
  }
}

/**
 * One WebP of the whole checked page — the only image evidence a check keeps.
 *
 * Cropping one tagged element per probe used to be the design, but it is the
 * reason a page nobody could read produced `shots=0` and therefore no evidence
 * at all: with nothing tagged there was nothing to capture, and the only way to
 * see WHY a probe found nothing was to infer it. Capturing the page whenever
 * the navigation succeeded answers that directly, and a single tall frame still
 * contains every surface the probes read, so nothing is lost.
 *
 * The capture runs AFTER the verdict is taken, so it cannot influence one. It
 * does cost ~1-2s, because `fullPage` scrolls the page and that can trigger
 * lazy-loaded requests on someone else's site.
 *
 * `frozen` (a page whose main thread locks, wallex.ir) takes a fast
 * viewport-only shot instead: no height probe (an evaluate there would hang
 * and cost the capture) and no full-page walk, which loses the race against
 * the lock — so it reports no height.
 */
async function capturePage(page, exchangeId, { frozen = false } = {}) {
  try {
    ensureShotsDir();
    if (frozen) {
      // Raw CDP capture, not Playwright's `page.screenshot`: the latter waits
      // for fonts and animation stability, which a page about to lock its main
      // thread never grants — the raw compositor call returns inside the same
      // window the probe gets. Viewport only; the full-page walk loses the
      // race against the lock.
      const client = await page.context().newCDPSession(page);
      const { data } = await Promise.race([
        client.send('Page.captureScreenshot', { format: 'jpeg', quality: SHOT_JPEG_QUALITY }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('screenshot timeout')), 5_000)
        ),
      ]).finally(() => {
        client.detach().catch(() => {});
      });
      const shot = await writeShot(Buffer.from(data, 'base64'), exchangeId);
      return { key: 'page', label: 'صفحهٔ بررسی‌شده (نمای اولیه)', ...shot };
    }

    const pageHeight = await evaluateInPage(
      page,
      () => document.documentElement.scrollHeight,
      undefined,
      'page height'
    );
    if (!Number.isFinite(pageHeight) || pageHeight <= 0) return null;

    const height = Math.min(Math.round(pageHeight), MAX_SHOT_HEIGHT);
    // Bounded like every other in-page operation: a wedged renderer also wedges
    // the compositor, so an unbounded screenshot would hang exactly as the
    // evaluate does.
    const buffer = await Promise.race([
      page.screenshot({
        fullPage: true,
        type: 'jpeg',
        quality: SHOT_JPEG_QUALITY,
        clip: { x: 0, y: 0, width: Math.max(1, page.viewportSize()?.width || 1440), height },
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('screenshot timeout')), 30_000)
      ),
    ]);
    const shot = await writeShot(buffer, exchangeId);
    // `height` is reported so a clamped capture is visible to the operator
    // rather than silently cropping the bottom of the page.
    return {
      key: 'page',
      label: 'کل صفحهٔ بررسی‌شده',
      ...shot,
      height,
      clamped: height < pageHeight,
    };
  } catch {
    return null;
  }
}

/* ---------------- evidence for the static path ---------------- */

/**
 * A best-effort photo for exchanges read over plain HTTP.
 *
 * The verdict for these exchanges comes from the HTTP fetch; the browser is
 * opened briefly afterwards, hands-off, purely to photograph the page (see
 * `shootWithoutProbe` — the capture needs no page JavaScript).
 */
async function captureStaticEvidence(adapter) {
  let context = null;
  try {
    const browser = await getBrowser();
    context = await browser.newContext({
      locale: 'fa-IR',
      viewport: { width: 1440, height: 1200 },
      deviceScaleFactor: 1,
      userAgent: USER_AGENT,
    });
    const page = await context.newPage();
    await page.goto(adapter.url, {
      waitUntil: 'domcontentloaded',
      timeout: config.navTimeoutMs,
    });
    // Long enough for the server-rendered frame to paint, short enough to
    // finish before the page's lock settles in.
    await page.waitForTimeout(2_000);
    const buffer = await shootWithoutProbe(page);
    const shot = await writeShot(buffer, adapter.id);
    return { key: 'page', label: 'کل صفحهٔ بررسی‌شده', ...shot };
  } catch {
    return null;
  } finally {
    if (context) await context.close().catch(() => {});
  }
}

/* ---------------- sampling ---------------- */

/**
 * Decide the verdict from the collected readings.
 *
 * The last reading wins, because that is the page a user ends up looking at.
 * A price that was visible earlier but is gone by the end is the render flash.
 */
function judgeObservation(readings) {
  const final = readings.length ? readings[readings.length - 1] : null;
  const finalAny = final ? final.any : false;
  const withPrice = readings.filter((r) => r.any);
  return {
    final,
    finalAny,
    sawPrice: withPrice.length > 0,
    flashed:
      !finalAny && withPrice.length > 0
        ? {
            detected: true,
            price: withPrice[0].primary ?? null,
            durationMs: withPrice[withPrice.length - 1].at,
          }
        : { detected: false, price: null, durationMs: 0 },
  };
}

/**
 * Read the page repeatedly until it has settled, then judge.
 *
 * Exchanges send a real price in the initial HTML and blank it out a moment
 * later, so judging the first reading would report a violation nobody sees.
 * The blanking time varies with how long hydration takes, so a fixed window is
 * not enough on its own: if a price is STILL on screen after the settle window
 * we watch a while longer to make sure it is not a late flash.
 */
async function sampleUntilSettled(page, adapter, probeInPage) {
  // Serializable slice of the adapter for the in-page probe.
  const probeArg = { coin: adapter.coin, marketId: adapter.marketId };
  const probe = probeInPage || adapter.probeInPage;
  const started = Date.now();
  const readings = [];
  let feedLive = false;
  let sawReady = false;
  // The browser tab's own title, kept beside the scrape and deliberately OUTSIDE
  // `readings`. `any` below is computed from `snap.probes` alone, and `any` is
  // what `finalAny` — and therefore `state` — is built on. Putting the title in
  // the probe array would make a compliant exchange flip to «تخلف» on the
  // strength of a string. See `buildReport`'s titlePrice for the other half of
  // this channel, which describes the title and never judges from it.
  let pageTitle = null;
  // What the probed surfaces showed in the last sample, kept whether or not the
  // probe was ready. `readings` is empty until a probe reports ready, so without
  // this a page that never renders reports no evidence AT ALL and «نامشخص» cannot
  // say which surfaces were looked for and what each one read — the one fact that
  // separates "the price is withheld" from "the page never rendered".
  let observed = [];
  // Samples where the visibility check itself succeeded. A sample we could not
  // verify is NOT evidence: if every sample fails here, the sample
  // set reports `visibilityError` so the verdict lands on «نامشخص».
  let samplesVerified = 0;
  let sampleError = null;
  // Set when a page that locks its own main thread (wallex.ir) wedges an
  // evaluate: every later evaluate on that page is dead too, so the sampling
  // loop stops instead of burning its budget on reads that can never land.
  let frozenDead = false;
  const isFrozenWedge = (err) =>
    !!adapter.frozenThread && String((err && err.message) || '').startsWith('ارزیابی صفحه بیش از');

  const sampleOnce = async () => {
    let snap = null;
    try {
      snap = await evaluateInPage(page, probe, probeArg, 'probe');
    } catch (err) {
      // A page that wedged its own main thread fails here, every sample, until
      // the check budget runs out. That is NOT a finding about the exchange —
      // recording it as `sampleError` would attribute a renderer deadlock to
      // whoever is being monitored.
      sampleError = sampleError || `استخراج قیمت ناموفق بود: ${err.message}`;
      if (isFrozenWedge(err)) frozenDead = true;
      return;
    }
    if (!snap) return;
    feedLive = feedLive || !!snap.feedLive;
    // Last value wins, and it survives every path below — including the one that
    // returns early because the probe is not ready. Otherwise the title would
    // be lost exactly when the page is hardest to read, which is when it is
    // most worth reporting.
    if (snap.pageTitle) pageTitle = snap.pageTitle;
    observed = (snap.probes || []).map((p) => ({ ...p }));
    if (!snap.ready) return;
    sawReady = true;

    // A price only counts if a user could actually see it. Text alone is not
    // evidence: exchanges keep prices in off-screen or clipped DOM nodes, and
    // reporting those would be a violation nobody could ever observe.
    const selectors = {};
    for (const p of snap.probes || []) selectors[p.key] = `[data-probe="${p.key}"]`;

    // FAIL CLOSED. If the visibility check itself throws, this sample is
    // discarded rather than counted: defaulting every probe to «visible» here
    // was the one path that could report a violation on a price nobody could
    // see — the exact inverse of what this monitor guarantees. A discarded
    // sample simply becomes no evidence, and if NO sample verifies, the sample
    // set reports `visibilityError` so the verdict lands on «نامشخص».
    let vis = null;
    try {
      vis = await evaluateInPage(page, probeVisibility, { selectors }, 'visibility');
      samplesVerified += 1;
    } catch (err) {
      sampleError = sampleError || `بررسی قابلیت دیدن ناموفق بود: ${err.message}`;
      if (isFrozenWedge(err)) frozenDead = true;
      return;
    }
    const visibleOf = (key) => (vis[key] ? vis[key].visible : true);
    const reasonOf = (key) => (vis[key] ? vis[key].reason : 'visible');

    readings.push({
      at: Date.now() - started,
      probes: snap.probes.map((p) => ({
        ...p,
        visible: visibleOf(p.key),
        reason: reasonOf(p.key),
      })),
      primary: (snap.probes.find((p) => p.primary) || {}).raw ?? null,
      // Computed from `snap.probes` ONLY. `pageTitle` is not a probe and must
      // never be added here: `any` feeds `finalAny`, which is what `state` is
      // built from, and a title that carries a price would then be able to
      // flip a compliant exchange to «تخلف».
      any: snap.probes.some((p) => isRealPrice(p.raw) && visibleOf(p.key)),
    });
  };

  const lastAny = () => (readings.length ? readings[readings.length - 1].any : false);

  // Phase 1 — let the page settle.
  while (Date.now() - started < config.settleMs && !frozenDead) {
    await sampleOnce();
    await page.waitForTimeout(config.sampleMs);
  }
  if (!frozenDead) await sampleOnce();

  // Phase 1b — the surface we watch may not have rendered at all. `settleMs` is
  // about watching a price settle; it is the wrong budget for waiting for a
  // surface to APPEAR, because sampleOnce takes no reading until the probe is
  // ready — so every sample above was a no-op and more settle time cannot help.
  // Adapters whose surface renders late declare `readyTimeoutMs`; the default 0
  // leaves the other nineteen exactly as they were.
  //
  // This only ever ADDS evidence before a judgement, never changes how a ready
  // page is judged. If the surface is still missing at the ceiling, sawReady is
  // still false and the verdict is still «نامشخص» — the same outcome as before,
  // after a longer bounded wait instead of an arbitrary one.
  const readyBudgetMs = Number(adapter.readyTimeoutMs) || 0;
  if (readyBudgetMs > 0 && !sawReady && !frozenDead) {
    const readyDeadline = Date.now() + readyBudgetMs;
    while (!sawReady && Date.now() < readyDeadline && !frozenDead) {
      await page.waitForTimeout(config.sampleMs);
      await sampleOnce();
    }
  }

  // Phase 1c — the surface rendered, but has not finished filling in.
  //
  // رمزینکس paints `.market-overview` with the headline slot reading "0" and
  // swaps in the real number up to ~1.8s later (measured 0-1805ms, n=3). That
  // state satisfied `ready`, so Phase 1b was skipped (it only runs while not
  // ready) and Phase 2 was skipped too (it only runs once a price has been
  // seen) — the check judged the half-filled page and reported «رعایت شده» with
  // the price on screen. This window is the missing case: ready, nothing priced
  // yet. It can only add evidence, so it cannot turn a «نامشخص» into anything
  // worse than it already is.
  if (sawReady && !lastAny() && config.fillTimeoutMs > 0 && !frozenDead) {
    const fillDeadline = Date.now() + config.fillTimeoutMs;
    while (!lastAny() && Date.now() < fillDeadline && !frozenDead) {
      await page.waitForTimeout(config.sampleMs);
      await sampleOnce();
    }
  }

  // Phase 2 — a price still on screen might be a slow flash, so confirm it
  // persists before calling it a violation.
  if (lastAny() && config.confirmMs > 0 && !frozenDead) {
    const deadline = Date.now() + config.confirmMs;
    while (Date.now() < deadline && !frozenDead) {
      await page.waitForTimeout(config.sampleMs);
      await sampleOnce();
      if (!lastAny()) break; // it disappeared: a late flash, not a violation
    }
  }

  const judged = judgeObservation(readings);

  return {
    readings: readings.map((r) => ({ at: r.at, primary: r.primary, any: r.any })),
    final: judged.final,
    finalAny: judged.finalAny,
    sawReady,
    feedLive,
    pageTitle,
    observed,
    flashed: judged.flashed,
    // Set only when the page reached ready but NOT ONE sample could be
    // visibility-verified. diagnose turns this into «نامشخص» with its own
    // reasonCode, so a broken page can never be read as a decided verdict.
    visibilityError:
      sawReady && samplesVerified === 0 && sampleError ? sampleError : null,
    // True when sampling was ended by the page freezing its own main thread
    // (wallex.ir). Whatever the last reading showed, the check could not
    // observe the page to its end — diagnose treats a priced last reading on
    // a frozen page as unverifiable rather than a confirmed violation.
    frozenEnded: frozenDead,
  };
}

/* ---------------- main ---------------- */

/** Render an exchange's page in a browser and report its settled price state. */
/**
 * Load one URL and run one probe over it. Reusable so an adapter can declare a
 * backup page with a completely different probe (different page, different
 * markup) without duplicating any of the settle/confirm/visibility logic.
 */
async function readPage(page, adapter, url, probeInPage) {
  const startedAt = Date.now();
  let navError = null;
  // What the server actually answered. A 5xx is not the same finding as "the
  // price element did not render" — اتراکس served 503 on exactly one route
  // while every sibling route was fine, and without this the monitor reported
  // that as «بخش قیمت در صفحه ظاهر نشد», which reads like a rendering problem.
  let httpStatus = null;

  try {
    const response = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: config.navTimeoutMs,
    });
    // A navigation that throws (timeout, DNS, net::ERR_*) gives no response.
    if (response) httpStatus = response.status();
  } catch (err) {
    navError = err.message;
  }

  let sample = {
    readings: [], final: null, sawReady: false, feedLive: false,
    pageTitle: null, observed: [], flashed: { detected: false, price: null, durationMs: 0 },
  };

  // A page that locks its main thread (wallex.ir) must be photographed EARLY.
  // The lock lands anywhere between ~0.4s and ~8s after load (measured), and
  // once it does even the compositor-level capture fails — after sampling
  // there would be no evidence at all. The early shot is the page's first
  // paint: exactly the flash this check is watching. It runs CONCURRENTLY with
  // the sampling below, because both are racing the same lock and neither may
  // delay the other past it. Sampling then runs until the lock ends it, and
  // the verdict is the last readable state.
  const frozen = !!adapter.frozenThread;
  let shot = null;
  let frozenCapture = null;
  if (!navError && frozen) {
    await page.waitForTimeout(250); // first paint before the shot
    frozenCapture = capturePage(page, adapter.id, { frozen: true }).catch(() => null);
  }

  if (!navError) sample = await sampleUntilSettled(page, adapter, probeInPage);

  if (frozenCapture) shot = await frozenCapture;

  // Shoot whenever the navigation succeeded, whatever the probe concluded. This
  // is the part that earns its keep: a page the probe could not read used to
  // produce `shots=0` and therefore no visual evidence at all, because with
  // element-cropping there was nothing tagged to capture. It runs after the
  // verdict is decided and can therefore never influence one. A frozen page
  // was already shot above — it cannot be photographed after sampling.
  if (!navError && !frozen) shot = await capturePage(page, adapter.id);
  const screenshots = shot ? [shot] : [];

  const probes = {};
  // A judged reading is the authoritative evidence. When there is none — the
  // probe never became ready, or no sample's visibility check could be
  // verified — the LAST thing the surfaces showed is still worth reporting, as
  // description only: every branch that reaches this with no judged reading
  // returns «نامشخص» before any probe value is judged.
  const described = sample.final ? sample.final.probes : (sample.observed || []);
  for (const p of described) {
    probes[p.key] = {
      label: p.label,
      raw: p.raw,
      primary: !!p.primary,
      visible: p.visible !== false,
      reason: p.reason || 'visible',
      // Optional: what the slot says when it holds no number (an empty
      // state), so the report can describe it instead of guessing.
      ...(p.emptyText ? { emptyText: p.emptyText } : {}),
    };
  }

  return {
    exchangeId: adapter.id,
    navError,
    // The browser path classifies its own failures from the net::ERR_* token Playwright
    // embeds in the message; there is no Node-level cause code to record.
    navErrorCode: null,
    httpStatus,
    ready: sample.sawReady,
    feedLive: sample.feedLive,
    // Carried beside the scrape, never inside `probes`. See sampleUntilSettled.
    pageTitle: sample.pageTitle || null,
    visibilityError: sample.visibilityError || null,
    frozenEnded: !!sample.frozenEnded,
    probes,
    flashed: sample.flashed,
    screenshots,
    durationMs: Date.now() - startedAt,
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * The result shape for a browser that could not give us a usable page.
 *
 * Shared by the two ways that can happen — a launch that never started, and a
 * browser that launched and was already dead by the time we asked it for a
 * context. Both are host-level, so both must be classified rather than thrown.
 */
function browserFailure(adapter, err, startedAt) {
  return {
    exchangeId: adapter.id,
    navError: null,
    navErrorCode: null,
    httpStatus: null,
    browserError: describeLaunchFailure(err),
    ready: false,
    feedLive: false,
    probes: {},
    flashed: { detected: false, price: null, durationMs: 0 },
    screenshots: [],
    durationMs: Date.now() - startedAt,
    fetchedAt: new Date().toISOString(),
  };
}

async function scrapeBrowser(adapter) {
  const startedAt = Date.now();

  // A browser that cannot launch is a problem with THIS HOST, not with the
  // exchange's page, and it is the one failure every browser-backed exchange hits
  // at once. Returning it as a finding keeps Playwright's twenty-line message out
  // of the log and lets the monitor name the cause once for the whole dashboard.
  let browser;
  try {
    browser = await getBrowser();
  } catch (err) {
    return browserFailure(adapter, err, startedAt);
  }

  let context;
  try {
    context = await browser.newContext({
      locale: 'fa-IR',
      viewport: { width: 1440, height: 1200 },
      // 1, not 2. The capture is one whole-page JPEG at q72 rather than a
      // 2x-scale crop per probe, so doubling the pixel count bought nothing:
      // verified on the live رمزینکس page, `2,683,498 IRR` is legible in the
      // headline, the order book and the trade list at 1x.
      deviceScaleFactor: 1,
      userAgent: USER_AGENT,
    });
  } catch (err) {
    // A newContext on a browser that died between checks fails here. Drop the
    // cached instance so the NEXT check relaunches a fresh browser. Classify it
    // rather than rethrowing: a browser that dies after launching is still a
    // host-level failure, and letting it escape reproduced exactly the raw-message
    // noise the browserError path exists to remove.
    await closeBrowser();
    return browserFailure(adapter, err, startedAt);
  }

  try {
    const page = await context.newPage();
    const primary = await readPage(page, adapter, adapter.url, adapter.probeInPage);

    // اتراکس disables its tether page outright. A 5xx from an adapter that
    // declares `http5xxMeansDisabled` is the finding, not a failure — the page
    // is switched off and shows no price — and the fallback market page must
    // never produce the verdict instead. diagnose turns this into compliance.
    if (adapter.http5xxMeansDisabled && primary.httpStatus >= 500) {
      return { ...primary, pageDisabled: true };
    }

    // A page that never loaded is not evidence either way. An adapter may
    // declare a backup surface, read with its own probe; the primary verdict is
    // only replaced when the backup both loads AND looks like it has a live feed
    // (see adapter.fallback.feedLooksAlive). Otherwise the original failure
    // stands, because a dead page must never read as compliance.
    const broken = primary.navError || (primary.httpStatus && primary.httpStatus >= 400);
    const fb = adapter.fallback;
    if (!broken || !fb || typeof fb.probeInPage !== 'function') return primary;

    const alt = await readPage(page, adapter, fb.url, fb.probeInPage);
    if (alt.navError || !alt.ready) {
      return { ...primary, fallbackTried: { url: fb.url, label: fb.label, trusted: false } };
    }
    let trusted = true;
    if (typeof fb.feedLooksAlive === 'function') {
      trusted = await evaluateInPage(page, fb.feedLooksAlive, undefined, 'feedLooksAlive').catch(
        () => false
      );
    }
    if (!trusted) {
      return { ...primary, fallbackTried: { url: fb.url, label: fb.label, trusted: false } };
    }
    return {
      ...alt,
      durationMs: Date.now() - startedAt,
      usedFallback: { url: fb.url, label: fb.label },
      // Keep the primary's status visible: a 503 on the public page is itself a
      // fact about the site, even when the backup page answers the question.
      primaryUrl: adapter.url,
      primaryHttpStatus: primary.httpStatus,
    };
  } finally {
    await context.close().catch(() => {});
  }
}

/**
 * Read an exchange whose page is fully server-rendered, using plain HTTP and
 * no browser for the VERDICT.
 *
 * Some sites (wallex.ir) permanently lock their main thread shortly after load,
 * which makes any in-page evaluation — including Playwright's own injected
 * script — hang indefinitely. For those we fetch the document and parse the
 * markup directly. The price is in the served HTML, so nothing is lost. The
 * browser is still opened afterwards, briefly and hands-off, to photograph the
 * page — see `captureStaticEvidence`; a compositor-level screenshot survives
 * the lock that an evaluate cannot.
 */
async function scrapeStatic(adapter) {
  const startedAt = Date.now();
  // `navErrorCode` carries Node's own classification of a network failure
  // (ENOTFOUND, ECONNREFUSED, ETIMEDOUT…). Without it the message for every
  // static-path network failure is the literal string "fetch failed", which is
  // identical whether DNS is blocked, the host refuses us, or we have no route.
  const failed = (navError, httpStatus = null, navErrorCode = null) => ({
    exchangeId: adapter.id,
    navError,
    navErrorCode,
    httpStatus,
    ready: false,
    feedLive: false,
    probes: {},
    flashed: { detected: false, price: null, durationMs: 0 },
    screenshots: [],
    durationMs: Date.now() - startedAt,
    fetchedAt: new Date().toISOString(),
  });

  // Declared out here deliberately: the status has to survive to the return
  // block below. Hoisting it inside the try was the bug — `res` is block-scoped
  // and referencing it from the return threw «res is not defined» on every
  // statically-read exchange, which took wallex offline entirely.
  let httpStatus = null;
  let html;
  try {
    const res = await fetch(adapter.url, {
      headers: { 'user-agent': USER_AGENT, accept: 'text/html,*/*' },
      signal: AbortSignal.timeout(config.fetchTimeoutMs),
    });
    httpStatus = res.status;
    if (!res.ok) return failed(`HTTP ${res.status}`, res.status);
    html = await res.text();
  } catch (err) {
    return failed(err.message, httpStatus, (err.cause && err.cause.code) || null);
  }

  let out;
  try {
    out = adapter.fetchProbe(html);
  } catch (err) {
    return failed(`parse failed: ${err.message}`);
  }

  // Evidence photo, best-effort and fully independent of the verdict below:
  // it needs no in-page evaluation (see captureStaticEvidence), and a missing
  // photo must never fail a check the fetch already answered.
  const evidence = await captureStaticEvidence(adapter);

  // Anchoring each probe on its caption means we cannot accidentally pick up a
  // hidden or zero-size duplicate the way a naive text scrape would, so a
  // static read is treated as visible.
  const probes = {};
  for (const p of out.probes || []) {
    probes[p.key] = { label: p.label, raw: p.raw, primary: !!p.primary, visible: true };
  }

  return {
    exchangeId: adapter.id,
    navError: null,
    navErrorCode: null,
    httpStatus,
    ready: !!out.ready,
    feedLive: !!out.feedLive,
    probes,
    flashed: { detected: false, price: null, durationMs: 0 },
    screenshots: evidence ? [evidence] : [],
    durationMs: Date.now() - startedAt,
    fetchedAt: new Date().toISOString(),
  };
}

async function scrapeExchange(adapter) {
  if (typeof adapter.fetchProbe === 'function') return scrapeStatic(adapter);
  return scrapeBrowser(adapter);
}

module.exports = {
  scrapeExchange,
  closeBrowser,
  getBrowser,
  preflightBrowser,
  describeLaunchFailure,
  isRealPrice,
  judgeObservation,
  migrateLegacyShots,
  listShots,
  // Exported so the sampling phases themselves can be tested with a stub page,
  // rather than only through the browser fixtures. The capture constants go with
  // them: test/verify-shots.js has to reproduce the capture EXACTLY, and a
  // verifier that quietly used different values would verify nothing.
  sampleUntilSettled,
  SHOTS_DIR,
  SHOTS_PER_EXCHANGE: config.shotsPerExchange,
  MAX_SHOT_HEIGHT,
  SHOT_JPEG_QUALITY,
  SHOT_WEBP_QUALITY,
};