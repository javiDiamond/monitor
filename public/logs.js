'use strict';

/* Log page: recent execution events, filterable by level and exchange, with
 * expandable per-entry debug metadata and copy/clear actions. */

/* global $, fa, faDateTime, relative, escapeHtml, wireTopbar, copyText */

const LEVEL_LABEL = { error: 'خطا', warn: 'هشدار', info: 'اطلاعات' };
const LEVEL_CLASS = { error: 'bad', warn: 'warn', info: 'ok' };
const LEVEL_LATIN = { error: 'error', warn: 'warn', info: 'info' };

/** Persian labels for the reason codes, with the raw code kept as a tooltip —
 * the table speaks Persian; the codes are grep-friendly identifiers. */
const CODE_LABEL = {
  frozen_flash: 'نمایش لحظه‌ای هنگام بارگذاری',
  flash: 'نمایش لحظه‌ای هنگام بارگذاری',
  title_price: 'قیمت در عنوان صفحه',
  page_disabled: 'صفحهٔ تتر غیرفعال شده است',
  http_error: 'پاسخ نامعتبر سرور',
  http_503: 'پاسخ نامعتبر سرور',
  hidden: 'قیمت منتشر نمی‌شود',
  shown: 'قیمت روی صفحه است',
  feed_stalled: 'صفحه کامل بارگذاری نشد',
  visibility_error: 'بررسی قابلیت دیدن ناموفق بود',
  browser_unavailable: 'مرورگر در دسترس نیست',
  browser_deps_missing: 'کتابخانه‌های مرورگر نصب نیستند',
  browser_not_installed: 'مرورگر نصب نشده است',
  browser_launch_failed: 'مرورگر اجرا نشد',
  check_error: 'خطا در بررسی',
  session_start: 'شروع نشست پایش',
  unreachable: 'سایت در دسترس نبود',
};

let lastSig = null;
let lastEntries = [];
/** Highest `seq` the table has already shown — rows above it are new since the
 * last poll and get a brief highlight. Undefined before the first render, so a
 * fresh page load does not paint the whole table as "new". */
let lastSeenSeq = null;

/** `seq` of the rows the operator has open, so a poll does not collapse them. */
const expanded = new Set();

/** Two-stage delete: arm, then confirm. No native dialog — the table polls every 10s. */
let clearArmed = false;
let clearTimer = null;

const CLEAR_ARM_MS = 4000;

/** Pull the filters, fetch, render. */
async function load() {
  const level = document.getElementById('levelFilter').value;
  const exchange = document.getElementById('exchangeFilter').value;
  const qs = new URLSearchParams();
  if (level) qs.set('level', level);
  if (exchange) qs.set('exchange', exchange);
  qs.set('limit', '400');

  try {
    const res = await fetch(`/api/logs?${qs.toString()}`);
    if (!res.ok) return;
    render(await res.json(), { level, exchange });
  } catch (err) {
    // Never leave a stale table looking like it just refreshed.
    console.error('log load failed:', err);
  }
}

/** The scalars worth putting on one line when copying rows as text. */
function metaSummary(e) {
  const m = e.meta;
  if (!m) return '';
  const parts = [];
  const put = (k, v) => {
    if (v === null || v === undefined || v === '') return;
    parts.push(`${k}=${v}`);
  };
  put('state', m.state);
  put('reason', m.reason);
  put('expect', m.expect);
  put('kind', m.netErr ? m.kind : null);
  put('netErr', m.netErr);
  put('navErrorCode', m.navErrorCode);
  put('httpStatus', e.httpStatus);
  if (e.durationMs) put('took', `${(e.durationMs / 1000).toFixed(1)}s`);
  put('avg', m.avgDurationMs ? `${Math.round(m.avgDurationMs / 1000)}s` : null);
  put('probes', m.probes ? Object.keys(m.probes).length : null);
  put('ready', m.ready === true ? 'y' : m.ready === false ? 'n' : null);
  put('feedLive', m.feedLive === true ? 'y' : m.feedLive === false ? 'n' : null);
  put('price', m.price);
  put('apiPrice', m.apiPrice);
  put('flash', m.flash && m.flash.detected ? `${m.flash.ms}ms` : null);
  put('fallback', m.fallback ? m.fallback.label : null);
  return parts.length ? ` [${parts.join(' ')}]` : '';
}

function render(data, filter) {
  const counts = data.bufferedCounts || {};
  const life = data.counts || {};
  $('logCounts').textContent =
    `${fa(counts.error || 0)} خطا • ${fa(counts.warn || 0)} هشدار • ${fa(counts.info || 0)} اطلاعات` +
    // "since start", not "total": clearing the list deliberately leaves these alone,
    // and calling them a total would read as a bug.
    ` (از ابتدای اجرا: ${fa((life.error || 0) + (life.warn || 0) + (life.info || 0))})`;

  renderClearBtn();

  const sig = JSON.stringify([data.entries, filter.level, filter.exchange]);
  if (sig === lastSig) return;
  lastSig = sig;
  lastEntries = data.entries || [];

  const body = $('logBody');
  if (!lastEntries.length) {
    body.innerHTML =
      '<tr class="empty"><td colspan="6">با این صافی‌ها رخدادی ثبت نشده است.</td></tr>';
    return;
  }

  body.innerHTML = lastEntries.map(renderRow).join('');
  // The rows just drawn are "seen"; only entries beyond this seq highlight on
  // the NEXT poll.
  lastSeenSeq = lastEntries.reduce((max, e) => Math.max(max, e.seq || 0), lastSeenSeq || 0);
}

function renderRow(e) {
  const cls = LEVEL_CLASS[e.level] || 'warn';
  const label = LEVEL_LABEL[e.level] || e.level;
  const ex = e.exchangeName
    ? `<a class="log-link" href="/exchange/${encodeURIComponent(e.exchangeId)}">${escapeHtml(e.exchangeName)}</a>`
    : '—';
  const codeText = e.code ? (CODE_LABEL[e.code] || e.code) : null;
  const code = codeText
    ? `<span class="log-code" title="${escapeHtml(e.code)}">${escapeHtml(codeText)}</span>`
    : '—';
  const http = e.httpStatus ? ` <span class="log-http">${fa(e.httpStatus)}</span>` : '';
  const dur = e.durationMs ? ` <span class="log-dur">${fa((e.durationMs / 1000).toFixed(1))} ثانیه</span>` : '';
  const hasMeta = !!(e.meta && Object.keys(e.meta).length);
  const isOpen = expanded.has(e.seq);
  // Arrived after the table was last drawn: a short highlight that fades via
  // CSS so the eye lands on what changed without a manual diff.
  const isNew = lastSeenSeq != null && e.seq > lastSeenSeq;

  const toggle = hasMeta
    ? `<td class="col-detail"><button class="log-toggle" type="button" data-seq="${e.seq}"
         aria-expanded="${isOpen}" title="جزئیات این رخداد">${isOpen ? 'بستن' : 'باز کردن'}</button></td>`
    : '<td class="col-detail">—</td>';

  const main =
    `<tr class="log-row log-${e.level}${isNew ? ' log-new' : ''}" data-seq="${e.seq}">` +
    `<td class="num" title="${escapeHtml(faDateTime(e.ts))}">${relative(e.ts)}</td>` +
    `<td><span class="badge ${cls}">${label}</span></td>` +
    `<td>${ex}</td>` +
    `<td>${code}</td>` +
    `<td class="log-msg">${escapeHtml(e.message)}${http}${dur}</td>` +
    `${toggle}</tr>`;

  if (!hasMeta) return main;
  return isOpen ? main + detailRow(e) : main;
}

/**
 * The full record for one entry: everything the table drops, plus the metadata.
 * LTR and pre-wrap so net::ERR_* codes, URLs and key names stay readable inside an
 * RTL page.
 */
function detailRow(e) {
  const lines = [`ts: ${e.ts}`];
  if (e.url) lines.push(`url: ${e.url}`);
  // `httpStatus` lives on the entry, not in `meta`, so the flattening loop below
  // never sees it and the expanded row omitted the one field that distinguishes
  // "the price element did not render" from "the server refused the page".
  // Worded the same way the row badge and the copy-as-text summary read, so the
  // three views agree.
  if (e.httpStatus) lines.push(`کد وضعیت سرور: ${e.httpStatus}`);
  if (e.hint) lines.push(`hint: ${e.hint}`);
  const m = e.meta || {};
  const flat = { ...m };
  if (m.probes) {
    for (const [key, p] of Object.entries(m.probes)) {
      flat[`probe.${key}`] = `raw=${JSON.stringify(p.raw)} visible=${p.visible} primary=${!!p.primary}`;
    }
    delete flat.probes;
  }
  for (const [k, v] of Object.entries(flat)) {
    lines.push(`${k}: ${v === null ? '—' : typeof v === 'object' ? JSON.stringify(v) : v}`);
  }
  return (
    `<tr class="log-detail"><td colspan="6"><pre>${escapeHtml(lines.join('\n'))}</pre></td></tr>`
  );
}

/** Expand/collapse a row. Rendering is cheap; a forced redraw keeps the sig guard honest. */
function onBodyClick(ev) {
  const btn = ev.target.closest('.log-toggle');
  if (!btn) return;
  const seq = Number(btn.dataset.seq);
  if (expanded.has(seq)) expanded.delete(seq);
  else expanded.add(seq);
  lastSig = null;
  load();
}

/** Swap a button's label briefly, as feedback. There is no toast helper in this app. */
function flash(btn, text, ms = 1600) {
  if (btn.dataset.flashing === '1') return;
  const original = btn.dataset.label || btn.textContent;
  btn.dataset.label = original;
  btn.dataset.flashing = '1';
  btn.textContent = text;
  setTimeout(() => {
    btn.textContent = original;
    delete btn.dataset.flashing;
  }, ms);
}

function renderClearBtn() {
  const btn = document.getElementById('clearBtn');
  if (!btn || btn.dataset.flashing === '1') return;
  btn.textContent = clearArmed ? 'مطمئن؟ پاک شود' : 'پاک کردن';
  btn.classList.toggle('btn-armed', clearArmed);
}

function disarmClear() {
  clearArmed = false;
  if (clearTimer) clearTimeout(clearTimer);
  clearTimer = null;
  renderClearBtn();
}

async function onClear() {
  const btn = document.getElementById('clearBtn');
  // Ignore clicks while the button is showing feedback ("۳ رخداد پاک شد"). Without
  // this the button would arm invisibly behind the message, and the click after that
  // would clear again with no confirmation ever shown.
  if (btn.dataset.flashing === '1') return;
  if (!clearArmed) {
    clearArmed = true;
    renderClearBtn();
    clearTimer = setTimeout(disarmClear, CLEAR_ARM_MS);
    return;
  }
  disarmClear();
  btn.disabled = true;
  try {
    const res = await fetch('/api/logs/clear', { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { cleared } = await res.json();
    lastSig = null;
    expanded.clear();
    await load();
    flash(btn, `${fa(cleared)} رخداد پاک شد`);
  } catch (err) {
    flash(btn, 'پاک نشد');
    console.error('clear failed:', err);
  } finally {
    btn.disabled = false;
  }
}

/**
 * One line per visible row, honouring the active filters.
 *
 * Latin digits and the ISO timestamp on purpose: this is pasted into terminals, issues
 * and search boxes, where Persian digits and a wall of RTL prose are a liability.
 */
async function onCopyList() {
  const btn = document.getElementById('copyListBtn');
  if (!lastEntries.length) {
    flash(btn, 'چیزی برای کپی نیست');
    return;
  }
  const lines = lastEntries.map((e) => {
    const cols = [
      e.ts,
      LEVEL_LATIN[e.level] || e.level,
      e.exchangeId || '-',
      e.code || '-',
      e.message,
    ];
    return cols.join('\t') + metaSummary(e);
  });
  const header =
    `# ${lastEntries.length} entries (visible filters) — copied ${new Date().toISOString()}`;
  const ok = await copyText(`${header}\n${lines.join('\n')}`);
  flash(btn, ok ? 'کپی شد' : 'کپی نشد');
}

async function onCopyReport() {
  const btn = document.getElementById('copyReportBtn');
  btn.disabled = true;
  try {
    const res = await fetch('/api/logs/report');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const ok = await copyText(text);
    flash(btn, ok ? 'کپی شد' : 'کپی نشد');
  } catch (err) {
    flash(btn, 'کپی نشد');
    console.error('report copy failed:', err);
  } finally {
    btn.disabled = false;
  }
}

/** Populate the exchange dropdown once, then leave it alone. */
function fillExchanges(exchanges) {
  const sel = document.getElementById('exchangeFilter');
  if (sel.options.length > 1) return;
  for (const ex of exchanges) {
    const opt = document.createElement('option');
    opt.value = ex.id;
    opt.textContent = ex.name;
    sel.appendChild(opt);
  }
}

wireTopbar({});

function wireFilters() {
  for (const id of ['levelFilter', 'exchangeFilter']) {
    document.getElementById(id).addEventListener('change', () => {
      lastSig = null; // force a redraw even if the data has not changed
      load();
    });
  }
  document.getElementById('refreshBtn').addEventListener('click', () => {
    lastSig = null;
    load();
  });
  document.getElementById('logBody').addEventListener('click', onBodyClick);
  document.getElementById('clearBtn').addEventListener('click', onClear);
  document.getElementById('copyListBtn').addEventListener('click', onCopyList);
  document.getElementById('copyReportBtn').addEventListener('click', onCopyReport);
}

(async function start() {
  wireFilters();
  try {
    const res = await fetch('/api/status');
    if (res.ok) {
      const data = await res.json();
      fillExchanges(data.exchanges || []);
      // The live pill in this page's topbar.
      const pill = document.getElementById('livePill');
      if (pill) {
        pill.dataset.state = data.checking ? 'loading' : 'ok';
        document.getElementById('livePillText').textContent = data.checking
          ? 'در حال بررسی…'
          : 'پایش فعال';
      }
    }
  } catch {
    /* the log page works without the status payload */
  }
  await load();
  setInterval(load, 10000);
})();
