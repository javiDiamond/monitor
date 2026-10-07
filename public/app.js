'use strict';

/* Overview page: current status of every exchange under surveillance. */

/* global fa, num, faDateTime, relative, escapeHtml, STATE_LABEL, stateFor,
   badgeFor, applyGlow, syncPolicy, syncInterval, setPill, wireTopbar,
   tickCountdown, progressBarHtml, stateStripHtml, renderHistoryRows */

let nextAt = null;
let lastExchangeSig = null;
let lastChipsSig = null;
let lastStatus = null;
const names = {};

/* The card being checked right now, and when we first saw it checking. The
 * check's own start time is server knowledge the API does not carry per
 * exchange, so the client's first sighting stands in for it — accurate to the
 * 5-second poll, which is what the bar's granularity is anyway. */
const checkingSince = {};

/* Client-side grid filters, encoded in the URL so a filtered view is
 * shareable and the back button behaves. */
let filterState = 'all';
let searchText = '';
/* Optional ordering: breaches first, then everything else in watchlist order. */
let violationsFirst = false;

const FILTERS = [
  ['all', 'همه'],
  ['compliant', 'رعایت شده'],
  ['violation', 'تخلف'],
  ['unknown', 'نامشخص'],
];

/** The filter bucket an exchange belongs to. An exchange with no report yet is
 * a flavour of «نامشخص» as far as filtering goes — its card says so itself. */
function filterKeyOf(e) {
  return e.report && e.report.state ? e.report.state : 'unknown';
}

/* ---------------- rendering ---------------- */

function renderStatus(s) {
  lastStatus = s;
  nextAt = s.nextCheckAt;
  syncPolicy(s.policy);
  syncInterval(s.intervalMs);
  renderEnvBanner(s.browserHealth);

  const overall = s.overall || {};
  const ui = stateFor({ state: overall.state });
  const exchanges = s.exchanges || [];
  const total = exchanges.length;

  // How many exchanges are breaching RIGHT NOW — from each exchange's latest
  // report, not from lifetime counters. This is the figure the pill, the hero
  // and the stat tiles all quote, so they can only ever agree with each other.
  const violatingNow = exchanges.filter((e) => e.report && e.report.state === 'violation');
  const nBad = violatingNow.length;

  const hero = $('hero');
  const loading = s.checking && !overall.totalChecks;
  hero.dataset.state = loading ? 'loading' : ui;

  applyGlow(loading ? 'unknown' : ui);

  setPill(
    ui,
    overall.state === 'violation'
      ? `تخلف در ${fa(nBad)} صرافی از ${fa(total)}`
      : overall.state === 'unknown'
        ? 'وضعیت نامشخص'
        : 'دستور در همه صرافی‌ها رعایت شده است',
    s.checking
  );

  const titles = {
    compliant: 'دستور حذف قیمت تتر در همه صرافی‌ها رعایت شده است',
    violation: `تخلف: ${fa(nBad)} صرافی از ${fa(total)} نرخ تتر را منتشر می‌کنند`,
    unknown: 'وضعیت دست‌کم یک صرافی نامشخص است',
  };
  $('heroTitle').textContent = titles[overall.state] || 'در حال بررسی…';
  $('heroDesc').textContent =
    overall.state === 'violation'
      ? `${fa(nBad)} صرافی از ${fa(total)} صرافی تحت نظارت نرخ تتر را روی صفحه نشان می‌دهند. برای جزئیات، روی نام هر صرافی بروید.`
      : `قیمت تتر در هر ${fa(total)} صرافی تحت نظارت از صفحه حذف شده است.`;
  $('heroBadge').textContent = STATE_LABEL[overall.state] || '—';

  const newest = exchanges
    .map((e) => e.report)
    .filter(Boolean)
    .sort((a, b) => (a.checkedAt < b.checkedAt ? 1 : -1))[0];
  $('metaChecked').textContent = newest
    ? `${faDateTime(newest.checkedAt)} (${relative(newest.checkedAt)})`
    : '—';
  $('metaCount').textContent = `${fa(total)} صرافی`;
  tickCountdown(nextAt, s.checking);

  // The refresh-scope dropdown: «همهٔ صرافی‌ها» plus one entry per exchange,
  // filled once from the first payload that has names.
  const scope = $('refreshScope');
  if (scope && scope.options.length <= 1 && exchanges.length) {
    for (const e of exchanges) {
      const opt = document.createElement('option');
      opt.value = e.id;
      opt.textContent = e.name;
      scope.appendChild(opt);
    }
  }

  renderCyclePanel(s, exchanges);
  renderFilters(exchanges);
  renderStats(overall, exchanges);
  renderExchanges(s, exchanges);
}

/**
 * Live cycle status while a check is running: how many exchanges the cycle has
 * covered and which one it is on, with a bar for the whole cycle. Hidden while
 * idle — the idle state's countdown lives in the meta row. On completion the
 * panel lingers for a few seconds with the cycle's duration, closing the loop
 * the progress bar opened instead of just vanishing.
 */
function renderCyclePanel(s, exchanges) {
  const el = $('cyclePanel');
  if (!el) return;
  const total = s.cycleTotal || exchanges.length;

  if (!s.checking) {
    // The completion moment: shown once, briefly, after a cycle ends.
    if (renderCyclePanel.wasChecking && s.checkStartedAt) {
      const secs = Math.max(
        1,
        Math.round((Date.now() - Date.parse(s.checkStartedAt)) / 1000)
      );
      el.hidden = false;
      el.innerHTML = `
        <div class="cycle-head">
          <span class="cycle-title cycle-done">بررسی کامل شد — ${fa(secs)} ثانیه</span>
        </div>`;
      clearTimeout(renderCyclePanel.hideTimer);
      renderCyclePanel.hideTimer = setTimeout(() => {
        el.hidden = true;
        el.innerHTML = '';
      }, 6000);
    } else {
      el.hidden = true;
      el.innerHTML = '';
    }
    renderCyclePanel.wasChecking = false;
    return;
  }

  renderCyclePanel.wasChecking = true;
  const current = exchanges.find((e) => e.checking);
  const pct = total ? Math.max(4, Math.round(((s.cycleDone || 0) / total) * 100)) : 0;
  // Time-based inputs for the per-second ticker: the count above only moves on
  // a poll, the bar below moves every second against the expected cycle time.
  const expectedMs = exchanges.reduce(
    (sum, e) => sum + ((e.stats && e.stats.avgDurationMs) || 12_000),
    0
  );
  el.hidden = false;
  el.innerHTML = `
    <div class="cycle-head">
      <span class="cycle-title">در حال بررسی ${fa(s.cycleDone || 0)} از ${fa(total)} صرافی</span>
      <span class="cycle-current">${
        current
          ? `در حال بررسی: <a href="/exchange/${encodeURIComponent(current.id)}">${escapeHtml(current.name)}</a>`
          : 'در حال آماده‌سازی…'
      }</span>
    </div>
    ${progressBarHtml(s.checkStartedAt, expectedMs)}`;
}

/** Filter chips with live counts. The search box is static markup; only the
 * chips re-render, so typing never loses focus. */
function renderFilters(exchanges) {
  const el = $('filterChips');
  if (!el) return;
  const counts = { all: exchanges.length, compliant: 0, violation: 0, unknown: 0 };
  for (const e of exchanges) counts[filterKeyOf(e)] += 1;

  const sig = JSON.stringify([counts, filterState, violationsFirst]);
  if (sig === lastChipsSig) return;
  lastChipsSig = sig;

  el.innerHTML = FILTERS.map(([key, label]) => `
    <button type="button" class="chip ${filterState === key ? 'active' : ''}" data-filter="${key}">
      ${label} <span class="chip-n">${fa(counts[key])}</span>
    </button>`).join('') +
    `<button type="button" class="chip ${violationsFirst ? 'active' : ''}" id="sortToggle"
        title="نمایش صرافی‌های دارای تخلف در ابتدای فهرست">تخلف‌ها اول</button>`;
}

function renderStats(overall, exchanges) {
  const rate = overall.compliancePercent;
  const rateEl = $('statCompliance');
  if (rate == null) {
    rateEl.textContent = '—';
    rateEl.className = 'stat-value';
  } else {
    rateEl.textContent = fa(rate.toFixed(1)) + '٪';
    rateEl.className = 'stat-value ' + (rate >= 99 ? 'ok' : rate > 0 ? 'warn' : 'bad');
  }
  // The rate counts exchanges now, so the hint must say the same thing. Quoting
  // a decided-CHECK count under a per-exchange rate is how the two diverge.
  $('statComplianceHint').textContent =
    overall.decidedExchanges != null
      ? `از ${fa(overall.exchangeCount || 0)} صرافی، ${fa(overall.decidedExchanges)} صرافی وضعیت قطعی دارند`
      : '—';

  // Breaching exchanges NOW, not a lifetime sum of violation checks. Each name
  // links straight to its page — with several breaches, hunting through the
  // grid for them is exactly the friction this tile should remove.
  const nowBad = exchanges.filter((e) => e.report && e.report.state === 'violation');
  const v = nowBad.length;
  const vEl = $('statViolations');
  vEl.textContent = v ? fa(v) : 'بدون تخلف';
  vEl.className = 'stat-value ' + (v ? 'bad' : 'ok');
  $('statViolationsHint').innerHTML = v
    ? nowBad.map((e) => `<a href="/exchange/${encodeURIComponent(e.id)}">${escapeHtml(e.name)}</a>`).join('، ')
    : '—';

  const lv = $('statLastViolation');
  if (overall.lastViolationAt) {
    lv.textContent = relative(overall.lastViolationAt);
    lv.className = 'stat-value bad';
    $('statLastViolationHint').textContent = `در ${faDateTime(overall.lastViolationAt)}`;
  } else {
    lv.textContent = 'ثبت نشده';
    lv.className = 'stat-value ok';
    $('statLastViolationHint').textContent = 'تا این لحظه هیچ تخلفی مشاهده نشده است';
  }

  $('statTotal').textContent = fa(overall.totalChecks || 0);
  // Current per-exchange split, from each exchange's latest report. Summing
  // lifetime check counters here was the source of the drift: the tile read
  // «۲۲ بررسی» against a watchlist of ۲۰ exchanges.
  const split = { compliant: 0, violation: 0, unknown: 0 };
  for (const e of exchanges) {
    const st = e.report && e.report.state;
    if (st && st in split) split[st] += 1;
  }
  $('statSplit').textContent =
    `${fa(split.compliant)} رعایت • ${fa(split.violation)} تخلف • ${fa(split.unknown)} نامشخص`;
}

/**
 * Say plainly, at the top of the page, when this host cannot run a browser.
 *
 * Without this the failure looked like 20 exchanges all going «نامشخص» at once,
 * which sends the reader to the log page and, from there, to the exchanges — none
 * of which are the problem. Only `ok === false` shows it: while the startup check
 * is still pending `browserHealth` is null, and flashing a warning at a healthy
 * machine would be its own kind of false alarm.
 */
function renderEnvBanner(health) {
  const el = $('envBanner');
  if (!el) return;
  if (!health || health.ok !== false) {
    el.hidden = true;
    el.innerHTML = '';
    return;
  }
  const hint = health.hint
    ? `<span class="banner-hint">راه‌حل: <code>${escapeHtml(health.hint)}</code></span>`
    : '';
  el.innerHTML =
    `<span class="banner-title">مرورگر اجرا نمی‌شود</span>` +
    // Scoped to the browser-backed exchanges on purpose. A static-path exchange
    // keeps working, so claiming every exchange went «نامشخص» was false — and it
    // contradicted the compliance tile beside it, which store.overall() computes
    // from decided exchanges only.
    `<span>${escapeHtml(health.message)} — تا رفع این مشکل، صرافی‌های مرورگرمحور بررسی نمی‌شوند.</span>` +
    hint;
  el.hidden = false;
}

/** One compact, clickable card per exchange, after the active filters. */
function renderExchanges(s, exchanges) {
  for (const ex of exchanges) names[ex.id] = ex.name;

  let visible = exchanges.filter((e) => {
    if (filterState !== 'all' && filterKeyOf(e) !== filterState) return false;
    if (searchText) {
      const q = searchText.trim().toLowerCase();
      if (q && !e.name.toLowerCase().includes(q) && !e.host.toLowerCase().includes(q)) return false;
    }
    return true;
  });

  if (violationsFirst) {
    const rank = (e) => (filterKeyOf(e) === 'violation' ? 0 : 1);
    visible = visible
      .map((e, i) => ({ e, i }))
      .sort((a, b) => rank(a.e) - rank(b.e) || a.i - b.i)
      .map((x) => x.e);
  }

  // The page re-renders every few seconds, but the cards are links. Rewriting
  // them unconditionally would pull a card out from under the pointer if the
  // user happened to be hovering or clicking, so only touch the DOM when the
  // rendered content actually differs. `checking` and the verdict strip are
  // part of that content — a card grows a progress bar the moment its check
  // starts.
  const sig = JSON.stringify([
    exchanges.map((e) => {
      const r = e.report;
      return [
        e.id, e.host, r && r.checkedAt, r && r.state, r && r.priceVisible,
        !!(r && r.flashNote), !!e.checking, e.recentStates || [],
      ];
    }),
    filterState, searchText, violationsFirst,
  ]);
  if (sig === lastExchangeSig) return;
  lastExchangeSig = sig;

  const started = s.checkStartedAt;
  const rows = visible.map((ex) => {
    names[ex.id] = ex.name;
    const r = ex.report;

    // Track when this card's check started, for the progress bar's clock.
    if (ex.checking && !checkingSince[ex.id]) checkingSince[ex.id] = new Date().toISOString();
    if (!ex.checking) delete checkingSince[ex.id];

    // Waiting for this cycle to reach it: dimmed, with a queue tag, so nineteen
    // idle cards read as "ordered queue" instead of "forgotten".
    const queued = !!s.checking && !!r && !!started && r.checkedAt < started && !ex.checking;

    const badge = ex.checking
      ? '<span class="badge warn">در حال بررسی…</span>'
      : r
        ? `<span class="badge ${stateFor(r)}">${escapeHtml(badgeFor(r))}</span>`
        : '<span class="badge warn">در انتظار بررسی</span>';

    const strip = stateStripHtml(ex.recentStates);
    const head = `<div class="ex-head">
        <div class="ex-id"><h3>${escapeHtml(ex.name)}</h3><span class="ex-host">${escapeHtml(ex.host)}</span></div>
        ${badge}
      </div>`;

    if (!r) {
      const waitingBar = ex.checking
        ? `<div class="ex-card-progress">${progressBarHtml(checkingSince[ex.id], ex.stats && ex.stats.avgDurationMs, 'در حال بررسی…')}</div>`
        : '';
      return `<a class="ex-card ${queued ? 'queued' : ''}" data-state="unknown" href="/exchange/${encodeURIComponent(ex.id)}">
        ${head}
        ${strip}
        ${queued ? '<span class="queue-tag">در صف بررسی</span>' : ''}
        ${waitingBar}
      </a>`;
    }

    const ui = stateFor(r);
    // A price is only ever shown when there is a violation; otherwise it is
    // hidden. The unit comes from the exchange (not every site uses Toman).
    const priceRow = r.priceVisible && r.price
      ? `<span class="ex-card-price bad">${escapeHtml(r.price.formatted)} ${escapeHtml(r.price.unit || 'تومان')}</span>`
      : `<span class="ex-card-price hidden">قیمت منتشر نمی‌شود</span>`;

    const flash = r.flashNote
      ? `<span class="flash-tag">نمایش لحظه‌ای هنگام بارگذاری</span>`
      : '';

    // While this exchange's check runs, its progress bar takes the footer's
    // place: the verdict being shown belongs to the PREVIOUS evaluation, and
    // the bar is the honest "this is being re-checked right now" signal.
    const foot = ex.checking
      ? `<div class="ex-card-progress">${progressBarHtml(checkingSince[ex.id], ex.stats && ex.stats.avgDurationMs, 'در حال بررسی…')}</div>`
      : `<div class="ex-card-foot">${priceRow}${flash}<span class="ex-more">جزئیات</span></div>`;

    return `<a class="ex-card ${queued ? 'queued' : ''}" data-state="${ui}" href="/exchange/${encodeURIComponent(ex.id)}">
      ${head}
      ${strip}
      ${queued ? '<span class="queue-tag">در صف بررسی</span>' : ''}
      <p class="ex-desc">${escapeHtml(r.title)}</p>
      ${foot}
    </a>`;
  }).join('');

  $('exchangeList').innerHTML =
    rows || '<div class="card panel empty-filter">صرافی‌ای با این فیلتر پیدا نشد.</div>';
}

async function renderHistory() {
  try {
    const res = await fetch('/api/history?limit=15');
    const data = await res.json();
    renderHistoryRows(data.entries || [], (e) => names[e.exchangeId] || e.exchangeId);
  } catch (err) {
    console.error('history render failed:', err);
  }
}

/* ---------------- data loop ---------------- */

async function load() {
  try {
    const res = await fetch('/api/status');
    renderStatus(await res.json());
  } catch (err) {
    // A silent catch here cost real time once: a throw inside render() made the
    // page sit on its static placeholders forever with nothing in the console.
    // Surface it — network failures included.
    console.error('dashboard render failed:', err);
  }
}

/** Reflect the active filter/search/sort in the URL, without history spam. */
function syncFilterUrl() {
  const qs = new URLSearchParams();
  if (filterState !== 'all') qs.set('filter', filterState);
  if (searchText.trim()) qs.set('q', searchText.trim());
  if (violationsFirst) qs.set('bad-first', '1');
  const url = qs.toString() ? `/?${qs.toString()}` : '/';
  history.replaceState(null, '', url);
}

/** Restore filters a shared or bookmarked URL came in with. */
function restoreFilterUrl() {
  const qs = new URLSearchParams(location.search);
  const f = qs.get('filter');
  if (f && FILTERS.some(([key]) => key === f)) filterState = f;
  searchText = qs.get('q') || '';
  violationsFirst = qs.get('bad-first') === '1';
}

wireTopbar({
  onRefresh: async () => {
    const scope = $('refreshScope') ? $('refreshScope').value : 'all';
    const res = await fetch(
      scope === 'all' ? '/api/check' : `/api/check/${encodeURIComponent(scope)}`,
      { method: 'POST' }
    );
    // A running cycle refuses the request. The detail page says so; so does
    // this one — a spinner that stops in silence reads as "done".
    if (res.status === 409) {
      const note = $('refreshNote');
      if (note) {
        note.textContent = 'بررسی دیگری در جریان است؛ نتیجه در چرخهٔ جاری می‌آید.';
        note.hidden = false;
        setTimeout(() => { note.hidden = true; }, 6000);
      }
    }
    await load();
    await renderHistory();
  },
});

$('filterChips').addEventListener('click', (ev) => {
  const btn = ev.target.closest('button');
  if (!btn) return;
  if (btn.id === 'sortToggle') {
    violationsFirst = !violationsFirst;
  } else if (btn.dataset.filter) {
    filterState = btn.dataset.filter;
  } else {
    return;
  }
  syncFilterUrl();
  lastExchangeSig = null; // force the grid to re-render through the filter
  lastChipsSig = null;
  load();
});

$('searchBox').addEventListener('input', (ev) => {
  searchText = ev.target.value || '';
  syncFilterUrl();
  lastExchangeSig = null;
  load();
});

restoreFilterUrl();
load();
renderHistory();
setInterval(load, 5000);
setInterval(() => tickCountdown(nextAt, lastStatus && lastStatus.checking), 1000);
setInterval(renderHistory, 15000);
