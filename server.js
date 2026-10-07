'use strict';

const path = require('path');
const express = require('express');

const config = require('./src/config');
const monitor = require('./src/monitor');
const store = require('./src/store');
const { closeBrowser, migrateLegacyShots, listShots } = require('./src/scraper');
const { get: getExchange } = require('./src/exchanges');
const { EXCHANGES } = require('./src/exchanges');
const log = require('./src/log');

const app = express();
const publicDir = path.join(__dirname, 'public');
const page = (file) => (req, res) => res.sendFile(path.join(publicDir, file));

app.use(express.json());

/* ---------- pages ---------- */

// Declared before the static mount so these win over express.static.
app.get('/', page('index.html'));
app.get('/exchange/:id', (req, res) =>
  getExchange(req.params.id) ? page('exchange.html')(req, res) : notFound(res)
);
app.get('/screenshots', page('screenshots.html'));
app.get('/logs', page('logs.html'));
app.use('/shots', express.static(path.join(__dirname, 'shots'), { maxAge: '1h' }));
app.use(express.static(publicDir));

/* ---------- api ---------- */

app.get('/api/status', (req, res) => {
  res.json(monitor.status());
});

/** Recent execution log, newest first, with lifetime counts per level. */
app.get('/api/logs', (req, res) => {
  res.json({
    counts: log.counts(),
    bufferedCounts: log.bufferedCounts(),
    exchanges: EXCHANGES.map((e) => ({ id: e.id, name: e.name })),
    entries: log.recent({
      level: req.query.level,
      exchangeId: req.query.exchange,
      limit: Math.min(Number(req.query.limit) || 300, 600),
    }),
  });
});

/** Everything one detail page needs, in a single round trip. */
/**
 * Full diagnostic bundle as plain text.
 *
 * Built server-side because most of it — the resolved browser channel, the effective
 * timings, the adapter list after filtering — is knowledge only the monitor module
 * has. The client copies the returned text verbatim.
 */
app.get('/api/logs/report', (req, res) => {
  res.type('text/plain; charset=utf-8').send(monitor.debugReport());
});

/**
 * Empty the log view.
 *
 * POST, like the app's other actions, and unauthenticated like the rest of it:
 * `POST /api/check` already lets a caller drive a real browser out to 20 third-party
 * sites, so clearing an in-memory buffer is the smaller exposure. The UI confirms
 * before it fires.
 *
 * Lifetime counters deliberately survive. They answer "how many errors since the
 * process started", which a view reset must not rewrite — and clearing the buffer
 * is precisely the way to make a fresh reproduction readable.
 */
app.post('/api/logs/clear', (req, res) => {
  const cleared = log.recent({ limit: 600 }).length;
  log.clear();
  res.json({ cleared });
});

app.get('/api/exchange/:id', (req, res) => {
  const ex = getExchange(req.params.id);
  if (!ex) return notFound(res);
  const limit = Math.min(Number(req.query.limit) || 40, 400);
  // The watchlist order, so the detail page can offer prev/next without
  // fetching the whole /api/status payload.
  const idx = EXCHANGES.findIndex((a) => a.id === ex.id);
  const neighbour = (n) => {
    if (!n) return null;
    return { id: n.id, name: n.name };
  };
  res.json({
    id: ex.id,
    name: ex.name,
    host: ex.host,
    url: ex.url,
    coin: ex.coin,
    report: store.report(ex.id),
    stats: store.store(ex.id).stats(),
    history: store.store(ex.id).recent(limit),
    // True only while the cycle is ON this exchange — the detail page's
    // progress bar is per-exchange, not the global cycle flag.
    checking: monitor.isChecking() && monitor.currentId() === ex.id,
    checkStartedAt: monitor.checkStartedAt(),
    checkingGlobal: monitor.isChecking(),
    intervalMs: config.checkIntervalMs,
    nextCheckAt: monitor.nextCheckAt(),
    policy: { expect: config.expect },
    neighbours: {
      prev: neighbour(EXCHANGES[idx - 1]),
      next: neighbour(EXCHANGES[idx + 1]),
    },
  });
});

/**
 * The evidence archive for one exchange: every kept screenshot (newest first),
 * each joined to the nearest history entry so a gallery row can show the
 * verdict that check reached. The join is by time because history rows carry
 * no screenshot reference and shot filenames carry no verdict — but a capture
  * is written moments after its verdict, so ±90s is unambiguous next to a
  * 30-minute interval.
 */
app.get('/api/exchange/:id/shots', (req, res) => {
  const ex = getExchange(req.params.id);
  if (!ex) return notFound(res);
  const limit = Math.min(Number(req.query.limit) || 12, config.shotsPerExchange);
  const history = store.store(ex.id).recent(config.historyLimit);
  const shots = listShots(ex.id, limit).map((s) => {
    const t = Date.parse(s.checkedAt);
    let best = null;
    let bestDiff = Infinity;
    for (const h of history) {
      const d = Math.abs(Date.parse(h.checkedAt) - t);
      if (d < bestDiff) {
        bestDiff = d;
        best = h;
      }
    }
    const joined = best && bestDiff <= 90_000
      ? { state: best.state, price: best.price, priceVisible: best.priceVisible, flash: best.flash }
      : { state: null, price: null, priceVisible: null, flash: null };
    return { ...s, ...joined };
  });
  res.json({
    id: ex.id,
    name: ex.name,
    host: ex.host,
    perExchange: config.shotsPerExchange,
    shots,
  });
});

app.get('/api/history', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 40, store.overall().totalChecks || 1);
  res.json({ entries: store.recent(limit), overall: store.overall() });
});

/**
 * runCheck returns null when a cycle is already in flight. Reporting that as
 * `{ok: true}` made the refresh button look like it had checked when nothing
 * ran at all — the user saw a spinner and silence.
 */
app.post('/api/check', async (req, res) => {
  const reports = await monitor.runCheck({ reason: 'manual' });
  if (reports === null) {
    return res.status(409).json({ ok: false, checking: true, error: 'بررسی دیگری در جریان است.' });
  }
  res.json(monitor.status());
});

/** Re-check a single exchange — used by the detail page's refresh button. */
app.post('/api/check/:id', async (req, res) => {
  const ex = getExchange(req.params.id);
  if (!ex) return notFound(res);
  const reports = await monitor.runCheck({ reason: 'manual', only: ex.id });
  if (reports === null) {
    return res.status(409).json({ ok: false, checking: true, id: ex.id, error: 'بررسی دیگری در جریان است.' });
  }
  res.json({ ok: true, id: ex.id });
});

app.post('/api/interval', (req, res) => {
  const seconds = Number(req.body && req.body.seconds);
  if (!Number.isFinite(seconds) || seconds < 15 || seconds > 14400) {
    return res.status(400).json({ error: 'بازه زمانی باید بین ۱۵ ثانیه تا ۴ ساعت باشد.' });
  }
  monitor.setIntervalMs(seconds * 1000);
  res.json({ ok: true, intervalMs: config.checkIntervalMs });
});

/**
 * Terminal catch-all: any path no route or static file claimed gets the styled
 * 404 page, not Express's default "Cannot GET". API paths still answer JSON.
 */
app.use((req, res) => notFound(res));

function notFound(res) {
  res.status(404);
  if (res.req && res.req.path.startsWith('/api/')) {
    return res.json({ error: 'صرافی مورد نظر یافت نشد.' });
  }
  return res.sendFile(path.join(publicDir, '404.html'));
}

/* Express 4 does not catch rejected promises from async handlers, so a throw
   inside one would leave the request hanging with no response and no log. This
   terminal middleware turns that into a visible 500. */
app.use((err, req, res, next) => {
  console.error('unhandled request error:', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'خطای داخلی هنگام پردازش درخواست.' });
});

app.listen(config.port, () => {
  console.log(`داشبورد پایش قیمت تتر روی http://localhost:${config.port} در حال اجراست`);
  // Pre-WebP evidence on disk is converted once, before the first cycle can
  // prune the directory a format older than the pruner now expects.
  migrateLegacyShots();
  monitor.start();
});

async function shutdown() {
  console.log('\nدر حال بستن برنامه...');
  await closeBrowser();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);