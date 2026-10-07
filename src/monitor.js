'use strict';

const config = require('./config');
const { EXCHANGES } = require('./exchanges');
const { scrapeExchange, closeBrowser, preflightBrowser } = require('./scraper');
const { fetchApiPrice } = require('./api');
const { buildReport } = require('./diagnose');
const store = require('./store');
const log = require('./log');
const { toPersianDigits } = require('./persian');

/**
 * The probe readings a verdict was derived from, flattened for the log.
 *
 * This is the single most useful thing to have when an exchange goes «نامشخص»: the
 * verdict alone says nothing about what the page actually contained.
 */
function summariseProbes(probes) {
  if (!probes || typeof probes !== 'object') return undefined;
  const out = {};
  for (const [key, p] of Object.entries(probes)) {
    out[key] = { raw: p.raw, visible: p.visible, primary: !!p.primary };
  }
  return Object.keys(out).length ? out : undefined;
}

let timer = null;
let running = false;
let nextCheckAt = null;
// When the cycle in flight began, and which exchange it is on right now — the
// dashboard's progress bar and cycle panel are built from these.
let checkStartedAt = null;
let currentId = null;
// How many exchanges the in-flight cycle has finished with. The dashboard's
// cycle panel quotes this instead of recounting reports client-side.
let cycleDone = 0;
let lastError = null;
const previousStates = new Map();

/** Last result of the startup launch check, surfaced on /api/status. */
let browserHealth = null;
// One entry per failure streak rather than one per exchange. A single missing OS
// library otherwise fills the log with nineteen identical lines every cycle, which
// is exactly the wall of text the classified message exists to replace.
let browserIssueLogged = false;

/**
 * Log the "this host cannot run a browser" finding, once per streak.
 *
 * The log carries the remedy alongside the reason because the reason alone
 * («مرورگر اجرا نشد») sends the reader looking at the exchanges instead of at the
 * machine they are standing on.
 */
function recordBrowserIssue(browserError) {
  browserHealth = { ok: false, checkedAt: new Date().toISOString(), version: null, ...browserError };
  if (browserIssueLogged) return;
  browserIssueLogged = true;
  log.push('error', `مرورگر اجرا نشد: ${browserError.message} — راه‌حل: ${browserError.hint}`, {
    code: 'browser_unavailable',
    hint: browserError.hint,
  });
}

/**
 * Reject if `promise` has not settled within `ms`.
 *
 * Playwright's own page.evaluate has no timeout, so a page that locks its main
 * thread can hang a check indefinitely. The race lets the monitor move on —
 * but the underlying work keeps running, so on timeout the caller must drop
 * the browser (see runCheck) rather than leave a context leaking.
 */
function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`بررسی بیش از ${toPersianDigits(Math.round(ms / 1000))} ثانیه طول کشید`)),
        ms
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Check one exchange: scrape, cross-check the API, judge, store.
 */
async function checkExchange(adapter, reason) {
  const [scrape, api] = await Promise.all([scrapeExchange(adapter), fetchApiPrice(adapter)]);
  const since = store.store(adapter.id) ? store.store(adapter.id).contextSince() : null;
  const report = buildReport({
    scrape,
    api,
    expect: config.expect,
    context: { since },
    unitLabel: adapter.unitLabel || 'تومان',
  });
  report.screenshots = scrape ? scrape.screenshots : [];
  report.exchangeName = adapter.name;
  report.reason = reason;
  store.add(report);
  await notifyTransition(report);

  const who = { exchangeId: adapter.id, exchangeName: adapter.name, url: adapter.url };
  const took = { durationMs: report.durationMs };

  // Read the per-exchange stats ONCE here and hang them off every log call this
  // function makes. `avgDurationMs` is what makes a `slow` warning interpretable
  // ("3× the average" is meaningless without the average), and the consecutive
  // counters say how long the current state has held.
  const stats = store.store(adapter.id) ? store.store(adapter.id).stats() : null;
  const fallbackSurface = scrape && (scrape.usedFallback || scrape.fallbackTried)
    ? scrape.usedFallback || scrape.fallbackTried
    : null;

  // Everything a reader needs to interpret any entry from this check, built once
  // and spread into each push below. `push()` copies it, so entries stay
  // independent snapshots even though they share this object.
  const common = {
    meta: {
      reason,
      attempt: reason === 'retry' ? 2 : 1,
      expect: config.expect,
      state: report.state,
      reasonCode: report.reasonCode || null,
      avgDurationMs: stats && stats.avgDurationMs ? Math.round(stats.avgDurationMs) : null,
      consecutive: stats
        ? { compliant: stats.consecutiveCompliant, violations: stats.consecutiveViolations }
        : null,
      ready: scrape ? !!scrape.ready : null,
      feedLive: scrape ? !!scrape.feedLive : null,
      // Presence only, never the value: the title is a browser-tab finding and
      // it never reaches the verdict, so a full copy here would only give the
      // log page a second, contradictory price to display.
      pageTitle: scrape && scrape.pageTitle ? true : null,
      titlePrice: report.titlePrice ? report.titlePrice.value : null,
      visibilityError: (scrape && scrape.visibilityError) || null,
      probes: summariseProbes(scrape && scrape.probes),
      price: report.price ? report.price.value : null,
      priceVisible: report.priceVisible === true,
      apiPrice: api ? api.price : null,
      shots: scrape ? scrape.screenshots.length : 0,
      flash: scrape && scrape.flashed
        ? { detected: !!scrape.flashed.detected, ms: scrape.flashed.durationMs }
        : null,
      fallback: fallbackSurface
        ? {
            label: fallbackSurface.label,
            // `usedFallback` carries no trusted flag at all, and a fallback that
            // answered IS trusted. Reporting it as false would be inventing a
            // finding, so the key is omitted unless the scraper set it.
            ...(fallbackSurface.trusted !== undefined
              ? { trusted: !!fallbackSurface.trusted }
              : {}),
          }
        : null,
      navErrorCode: (scrape && scrape.navErrorCode) || null,
      // How many whole-page captures this check produced. Now 1 or 0, never N:
      // the image is the page rather than one crop per probe.
      pageHeight: scrape && scrape.screenshots && scrape.screenshots[0]
        ? scrape.screenshots[0].height
        : null,
    },
  };

  /* ---- what did this check actually run into? ---- */

  // The browser would not start, so no page was ever read. Every browser-backed
  // exchange hits this at once and none of them says anything about its own site,
  // so it is reported once for the dashboard and each exchange keeps the
  // «نامشخص» verdict buildReport derived, with its own reason attached.
  if (scrape && scrape.browserError) {
    recordBrowserIssue(scrape.browserError);
    return report;
  }

  // The verdict came from a backup surface because the primary would not load.
  // Worth its own entry: the number is real, but it is not from the page the
  // exchange publishes for the public.
  if (scrape && scrape.usedFallback) {
    log.push('warn', `صفحهٔ اصلی در دسترس نبود؛ نتیجه از «${scrape.usedFallback.label}» خوانده شد`, {
      ...who, code: 'used_fallback', url: scrape.usedFallback.url,
      httpStatus: scrape.primaryHttpStatus, ...took, ...common,
    });
  }
  if (scrape && scrape.fallbackTried && !scrape.fallbackTried.trusted) {
    log.push('warn', `صفحهٔ جایگزین «${scrape.fallbackTried.label}» خوانده شد ولی فید قیمت آن زنده نبود`, {
      ...who, code: 'fallback_untrusted', url: scrape.fallbackTried.url,
      httpStatus: scrape.httpStatus, ...took, ...common,
    });
  }

  // The page would not load at all.
  if (scrape && scrape.navError) {
    log.push('error', `صفحه باز نشد: ${scrape.navError}`, {
      ...who, code: 'nav_error', httpStatus: scrape.httpStatus, ...took,
      ...common,
      // The raw message above cannot tell four different problems apart. The
      // net::ERR_* token Playwright already embedded is what separates "my host
      // has no route", "DNS is blocked", "the exchange refused us" and "too slow".
      // These go INSIDE meta: a flat key would be dropped by push()' allowlist.
      meta: { ...common.meta, ...log.classifyNavError(scrape.navError, scrape.navErrorCode) },
    });
    return report;
  }

  // The server answered, but not with a usable page. This is the finding that
  // was invisible before: اتراکس returned 503 on its tether route while every
  // sibling route was fine, and the monitor reported it as a rendering problem.
  if (scrape && scrape.httpStatus && scrape.httpStatus >= 400) {
    log.push('warn', `سرور وضعیت ${scrape.httpStatus} برگرداند`, {
      ...who, code: `http_${scrape.httpStatus}`, httpStatus: scrape.httpStatus, ...took, ...common,
    });
  }

  // Undecided — the case the log page exists for. Carry the reason the judge
  // gave, so the operator can see WHY without opening the exchange's page.
  if (report.state === 'unknown') {
    log.push('warn', `وضعیت نامشخص: ${report.description || 'دلیلی ثبت نشده'}`, {
      ...who,
      code: report.reasonCode || 'unknown',
      httpStatus: scrape ? scrape.httpStatus : null,
      ...took, ...common,
    });
  }

  // A price that appeared during load and vanished. Real and worth knowing,
  // but it is not the settled state the verdict is based on.
  if (report.flashNote) {
    log.push('warn', 'قیمت هنگام بارگذاری دیده شد و سپس حذف شد', { ...who, code: 'flash', ...took, ...common });
  }

  // The price is in the browser tab's title but not in the page's own surfaces,
  // so the verdict still reads «رعایت شده». Worth its own entry: it is the case
  // where the dashboard number and the tab bar disagree, and nothing else
  // records it. Only fires when the page WAS readable — on an unreadable page
  // there is nothing to compare the title against, and saying the price "was
  // not seen on the page" would blame the page for our failure to read it.
  if (report.titlePrice && report.state === 'compliant') {
    log.push(
      'warn',
      `قیمت در عنوان صفحه نمایش داده می‌شود (${report.titlePrice.formatted} ${report.titlePrice.unit}) ولی روی خود صفحه نیست`,
      { ...who, code: 'title_price', ...took, ...common }
    );
  }

  // Unusually slow. The threshold is deliberately generous — 3× the average —
  // so it only fires on checks that genuinely dragged.
  const avg = stats ? stats.avgDurationMs : null;
  if (avg && report.durationMs > avg * 3) {
    log.push('warn', `بررسی کند بود: ${(report.durationMs / 1000).toFixed(1)} ثانیه`, {
      ...who, code: 'slow', durationMs: report.durationMs, ...common,
    });
  }

  // A decided outcome — the ordinary case. Only say this when there WAS a
  // verdict: an unreadable page already logged a `warn` above carrying the
  // reason, and pairing that with "the check completed fine" reads as if the
  // exchange had answered.
  if (report.state !== 'unknown') {
    log.push(
      'info',
      report.state === 'violation'
        ? `تخلف: قیمت تتر روی صفحه نمایش داده می‌شود`
        : 'بررسی کامل شد؛ قیمت تتر منتشر نشده است',
      { ...who, code: report.reasonCode || report.state, ...took, ...common }
    );
  }

  return report;
}

/**
 * Check every exchange, or just one when `only` names an exchange id.
 * Returns null when a check is already in flight.
 */
/**
 * Check every exchange, or just one when `only` names an exchange id.
 * Returns null when a check is already in flight.
 */
async function runCheck({ reason = 'scheduled', only = null } = {}) {
  if (running) return null;
  running = true;
  checkStartedAt = new Date().toISOString();
  cycleDone = 0;
  const reports = [];
  // Declared outside the loop so the post-cycle reset can read the whole cycle's
  // tally. See the browser-level accounting comment below.
  let browserFailures = 0;
  let browserChecked = 0;
  const list = only ? EXCHANGES.filter((e) => e.id === only) : EXCHANGES;
  try {
    for (const adapter of list) {
      currentId = adapter.id;
      // A hard deadline per exchange. Playwright's page.evaluate has no timeout,
      // so a page that locks its main thread would otherwise hold `running`
      // forever and silently stall every exchange behind it. On timeout the
      // browser is dropped too: a hung evaluate leaves a context open, and the
      // next check relaunches cleanly.
      let report;
      let timedOut = false;
      try {
        report = await withTimeout(checkExchange(adapter, reason), config.checkTimeoutMs, adapter.id);
      } catch (err) {
        timedOut = true;
        report = buildReport({ scrape: null, api: null, expect: config.expect });
        report.exchangeId = adapter.id;
        report.exchangeName = adapter.name;
        report.screenshots = [];
        report.error = err.message;
        report.reason = reason;
        // The real cause reaches the detail page, which renders `detail`.
        report.detail = err.message;
        store.add(report);
        log.push('error', `خطا در بررسی: ${err.message}`, {
          exchangeId: adapter.id,
          exchangeName: adapter.name,
          url: adapter.url,
          code: 'check_error',
          // A thrown scraper error can be a network failure too, so it gets the
          // same classification rather than being treated as always-unknown.
          meta: { reason, ...log.classifyNavError(err.message, err.cause && err.cause.code) },
        });
        await closeBrowser().catch(() => {});
      }

      // ONE retry when a page loaded but showed nothing. A slow render or a
      // partial hydrate is the commonest cause of a spurious «نامشخص» — this is
      // the transient that flipped نوبیتکس and تبدیل on single cycles. Only
      // feed_stalled is retried: unreachable, http_error and visibility_error
      // are real findings, and re-hitting a dead site twice per cycle helps
      // nobody. The retry's report is kept either way — it is newer evidence.
      if (!timedOut && report.state === 'unknown' && report.reasonCode === 'feed_stalled') {
        report = await withTimeout(checkExchange(adapter, 'retry'), config.checkTimeoutMs, adapter.id);
      }

      reports.push(report);
      cycleDone += 1;

      // Browser-level accounting, per cycle rather than per exchange. Clearing the
      // "already logged" flag on the first exchange that reached a verdict let an
      // INTERMITTENT launch failure re-arm it every other exchange, putting several
      // identical lines back in the log every cycle — the noise this exists to
      // remove. Only a whole cycle with no browser failure clears it.
      //
      // Keyed on the adapter, not on the report: an adapter read without the
      // browser must neither count as a browser failure nor count as proof the
      // browser works. (No current adapter reads statically; the guard stays
      // for adapters that declare `fetchProbe` again.)
      if (typeof adapter.fetchProbe !== 'function') {
        browserChecked += 1;
        if (report.reasonCode === 'browser_unavailable') browserFailures += 1;
      }
    }

    // Drop the unhealthy health alongside the log flag. Nothing re-runs the
    // startup preflight, so a browser that came back on its own would otherwise
    // leave the dashboard banner claiming the monitor is broken while it is
    // visibly checking pages.
    if (browserFailures === 0 && browserChecked > 0) {
      browserIssueLogged = false;
      if (browserHealth && browserHealth.ok === false) browserHealth = null;
    }

    lastError = null;
    return reports;
  } catch (err) {
    lastError = err.message;
    return reports;
  } finally {
    running = false;
    currentId = null;
  }
}

/** Fire the webhook when an exchange's compliance state changes. */
async function notifyTransition(report) {
  if (!config.webhookUrl) return;
  const prev = previousStates.get(report.exchangeId);
  if (prev === undefined) {
    previousStates.set(report.exchangeId, report.state);
    return;
  }
  if (prev === report.state) return;
  previousStates.set(report.exchangeId, report.state);

  const name = report.exchangeName || report.exchangeId;
  const text =
    report.state === 'violation'
      ? `🚨 تخلف در ${name} — قیمت تتر روی صفحه نمایش داده می‌شود${
          report.price ? `: ${report.price.formatted} تومان` : ''
        }`
      : report.state === 'compliant'
        ? `✅ ${name} — بازگشت به وضعیت رعایت دستور (قیمت تتر پنهان است).`
        : `⚠️ ${name} — وضعیت نامشخص شد.`;

  try {
    await fetch(config.webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text,
        exchangeId: report.exchangeId,
        exchangeName: name,
        state: report.state,
        priceVisible: report.priceVisible,
        price: report.price ? report.price.value : null,
        flashNote: report.flashNote || null,
        policy: config.expect,
        checkedAt: report.checkedAt,
        screenshots: report.screenshots || [],
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    /* webhook is best-effort */
  }
}

/**
 * Schedule the next cycle from NOW. Called only when no cycle is in flight —
 * after a cycle fully completes, or when the operator changes the interval —
 * so the countdown the UI shows is anchored to COMPLETION: a cycle that takes
 * longer simply pushes the next one back, and the counter the user sees does
 * not start ticking until the current evaluation is entirely done.
 */
function scheduleNext() {
  if (timer) clearTimeout(timer);
  nextCheckAt = Date.now() + config.checkIntervalMs;
  timer = setTimeout(runCycle, config.checkIntervalMs);
}

/** One scheduled cycle, then the countdown for the next one begins. */
async function runCycle() {
  const reports = await runCheck({ reason: 'scheduled' });
  if (reports === null) {
    // A manual check was in flight when the tick fired. Re-run shortly rather
    // than skipping a whole interval — but still anchored to a completion.
    nextCheckAt = Date.now() + 5_000;
    timer = setTimeout(runCycle, 5_000);
    return;
  }
  scheduleNext();
}

/**
 * Record the deployment's own fingerprint, once per process start.
 *
 * Every value here is the kind of thing that makes one machine behave differently
 * from another and that nothing else records: the resolved policy, the effective
 * timeouts, which browser channel actually launched, and which exchanges the
 * EXCHANGES filter left in force. Today all of it exists only as console output in
 * the terminal, so it never reaches the log page — and the log page is where an
 * operator ends up. After a restart, this single line is the whole context.
 */
function logSessionStart() {
  const withApi = EXCHANGES.filter((a) => a.api).length;
  const withFallback = EXCHANGES.filter((a) => a.fallback).length;
  log.push('info', 'پایش شروع شد؛ پیکربندی مؤثر این اجرا', {
    code: 'session_start',
    meta: {
      node: process.version,
      pid: process.pid,
      platform: process.platform,
      arch: process.arch,
      uptimeSec: Math.round(process.uptime()),
      expect: config.expect,
      port: config.port,
      checkIntervalMs: config.checkIntervalMs,
      checkTimeoutMs: config.checkTimeoutMs,
      navTimeoutMs: config.navTimeoutMs,
      settleMs: config.settleMs,
      sampleMs: config.sampleMs,
      confirmMs: config.confirmMs,
      fetchTimeoutMs: config.fetchTimeoutMs,
      historyLimit: config.historyLimit,
      headless: config.headless,
      browserChannel: config.browserChannel,
      // The channel that actually launched, so an msedge -> chromium fallback is
      // visible rather than inferred from a config value that never took effect.
      browserResolved: browserHealth ? browserHealth.channel : null,
      browserVersion: browserHealth ? browserHealth.version : null,
      exchangeCount: EXCHANGES.length,
      exchanges: EXCHANGES.map((a) => a.id),
      apiBacked: withApi,
      withFallback,
      // Presence only. The webhook URL is a secret and the override values can
      // contain credentials in a query string.
      webhook: !!config.webhookUrl,
      urlOverrides: Object.keys(process.env)
        .filter((k) => k.startsWith('EXCHANGE_URL_'))
        .sort(),
    },
  });
}

/**
 * Build the full diagnostic bundle as plain text, ready to paste into a bug report.
 *
 * Assembled here rather than in the browser because most of it is knowledge only this
 * module has: the resolved browser channel (which differs from the configured one
 * whenever the Edge -> Chromium fallback fires), the effective timings, and the adapter
 * list after the EXCHANGES filter. Shipping those to the client just to have it hand
 * them back would create a second source of truth for the same values.
 *
 * Deliberately ASCII/Latin despite the Persian UI: the artifact gets pasted into
 * terminals, issues and grep, where Persian digits and RTL text are a liability.
 *
 * The session_start entry already carries most of this as structured meta; this
 * flattens it alongside the log so one paste carries both the context and the evidence.
 */
function debugReport() {
  const entries = log.recent({ limit: 600 }); // unfiltered: a filtered export hides evidence
  const buffered = log.bufferedCounts();
  const lifetime = log.counts();
  const out = [];

  out.push('=== monitor debug report (USDT/IRT compliance dashboard) ===');
  out.push(`generatedAt: ${new Date().toISOString()}`);
  out.push('');

  out.push('--- runtime ---');
  out.push(`node: ${process.version}`);
  out.push(`platform: ${process.platform} ${process.arch}`);
  out.push(`pid: ${process.pid}`);
  out.push(`uptimeSec: ${Math.round(process.uptime())}`);
  out.push(`monitorStartedAt: ${store.startedAt}`);
  out.push('');

  out.push('--- policy ---');
  out.push(`expect: ${config.expect}   (hidden = price must not be published)`);
  out.push(`port: ${config.port}`);
  out.push('');

  out.push('--- timings (ms) ---');
  out.push(`checkIntervalMs: ${config.checkIntervalMs}`);
  out.push(`checkTimeoutMs: ${config.checkTimeoutMs}`);
  out.push(`navTimeoutMs: ${config.navTimeoutMs}`);
  out.push(`settleMs: ${config.settleMs}`);
  out.push(`sampleMs: ${config.sampleMs}`);
  out.push(`confirmMs: ${config.confirmMs}`);
  out.push(`fetchTimeoutMs: ${config.fetchTimeoutMs}`);
  out.push(`historyLimit: ${config.historyLimit}`);
  out.push('');

  out.push('--- browser ---');
  out.push(`headless: ${config.headless}`);
  out.push(`channelRequested: ${config.browserChannel}`);
  out.push(`channelResolved: ${browserHealth ? browserHealth.channel : 'unknown'}`);
  out.push(`version: ${browserHealth ? browserHealth.version || 'unknown' : 'unknown'}`);
  out.push(`ok: ${browserHealth ? String(browserHealth.ok) : 'unknown'}`);
  if (browserHealth && browserHealth.ok === false) {
    out.push(`problem: ${browserHealth.code} - ${browserHealth.message}`);
    out.push(`remedy: ${browserHealth.hint}`);
  }
  out.push('');

  out.push('--- exchanges ---');
  for (const a of EXCHANGES) {
    out.push(
      `${a.id}\t${a.url}\tapi:${a.api ? 'yes' : 'no'}\t` +
        `fallback:${a.fallback ? a.fallback.label || 'yes' : 'no'}\t` +
        `mode:${a.fetchProbe ? 'static' : 'browser'}`
    );
  }
  out.push('');

  out.push('--- counts ---');
  out.push(`buffered: info=${buffered.info} warn=${buffered.warn} error=${buffered.error}`);
  out.push(`lifetimeSinceStart: info=${lifetime.info} warn=${lifetime.warn} error=${lifetime.error}`);
  out.push('');

  out.push(`--- entries (${entries.length} of max 600, newest first, JSON) ---`);
  out.push(JSON.stringify(entries, null, 2));

  return out.join('\n');
}

/**
 * Verify the host can launch a browser before the first cycle starts.
 *
 * The preflight shares the cached browser (getBrowser/closeBrowser), so it MUST
 * finish before any exchange runs: fired concurrently, its closeBrowser() closed
 * the browser the first exchange was already holding, which failed that check with
 * a raw Playwright message while browserHealth reported ok:true. Sequential, the
 * cost is one launch (~1s) before the first cycle — and server.js does not await
 * start(), so the HTTP server is already listening throughout.
 */
async function runPreflight() {
  try {
    const health = await preflightBrowser();
    browserHealth = health;
    if (health.ok) {
      browserIssueLogged = false;
      logSessionStart();
      return;
    }
    recordBrowserIssue(health);
  } catch (err) {
    // preflightBrowser does not throw, but a bug in it must never be the reason
    // monitoring never starts.
    console.error('browser preflight failed:', err.message);
  }
}

async function start() {
  await runPreflight();
  // The first cycle runs immediately; the countdown to the SECOND one starts
  // only when it has fully completed (runCycle -> scheduleNext).
  Promise.resolve(runCheck({ reason: 'startup' })).finally(scheduleNext);
}

function setIntervalMs(ms) {
  config.checkIntervalMs = ms;
  scheduleNext();
}

function status() {
  return {
    policy: { expect: config.expect },
    overall: store.overall(),
    exchanges: EXCHANGES.map((a) => ({
      id: a.id,
      name: a.name,
      host: a.host,
      url: a.url,
      coin: a.coin,
      report: store.report(a.id),
      stats: store.store(a.id).stats(),
      // True only for the exchange the cycle is currently ON, so the dashboard
      // can put a progress bar on exactly one card.
      checking: running && currentId === a.id,
      // Last 12 verdicts with their timestamps, for the card's mini timeline.
      recentStates: store.store(a.id).recent(12).map((h) => ({ s: h.state, t: h.checkedAt })),
    })),
    intervalMs: config.checkIntervalMs,
    nextCheckAt: nextCheckAt ? new Date(nextCheckAt).toISOString() : null,
    checking: running,
    // When the cycle in flight began. A null value with `checking: true` cannot
    // happen; a stale value with `checking: false` is the LAST cycle's start,
    // which the dashboard uses to count what that cycle already covered.
    checkStartedAt: checkStartedAt ? new Date(checkStartedAt).toISOString() : null,
    // Progress of the cycle in flight, straight from the loop — the client
    // cannot count reports between polls. Null while idle.
    cycleDone: running ? cycleDone : null,
    cycleTotal: EXCHANGES.length,
    lastError,
    // Null until the startup preflight settles. The dashboard shows the banner on
    // `ok === false` only, so a pending check never flashes a false alarm.
    browserHealth,
  };
}

module.exports = {
  start,
  runCheck,
  status,
  setIntervalMs,
  debugReport,
  isChecking: () => running,
  currentId: () => currentId,
  checkStartedAt: () => (checkStartedAt ? new Date(checkStartedAt).toISOString() : null),
  nextCheckAt: () => (nextCheckAt ? new Date(nextCheckAt).toISOString() : null),
};