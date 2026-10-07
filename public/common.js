'use strict';

/**
 * Shared between the overview page and the per-exchange detail pages.
 * Persian formatting, state mapping, and the top bar wiring both pages need.
 */

const FA = '۰۱۲۳۴۵۶۷۸۹';
const fa = (s) => String(s).replace(/[0-9]/g, (d) => FA[Number(d)]);
const num = (n) => fa(Math.round(n).toLocaleString('en-US'));

const $ = (id) => document.getElementById(id);

function faTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat('fa-IR', {
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).format(d);
}

function faDateTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat('fa-IR-u-ca-persian', {
    dateStyle: 'medium', timeStyle: 'medium',
  }).format(d);
}

function relative(iso) {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '—';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 10) return 'همین حالا';
  if (s < 60) return `${fa(s)} ثانیه پیش`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${fa(m)} دقیقه پیش`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${fa(h)} ساعت پیش`;
  return `${fa(Math.floor(h / 24))} روز پیش`;
}

function countdown(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const t = Math.round(ms / 1000);
  return fa(`${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`);
}

/** Is this raw page value a real (>0) price? Mirrors the server rule. */
function parseNum(raw) {
  if (raw == null) return 0;
  const s = String(raw).replace(/[۰-۹]/g, (d) => String(FA.indexOf(d)));
  const v = Number(s.replace(/[,\s]/g, '').replace(/[^\d.]/g, ''));
  return Number.isFinite(v) ? v : 0;
}

const escapeHtml = (s) =>
  String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );

/* ---------------- state mapping ---------------- */

const STATE_UI = { compliant: 'ok', violation: 'bad', unknown: 'unknown' };
const STATE_LABEL = { compliant: 'رعایت شده', violation: 'تخلف', unknown: 'نامشخص' };

/** CSS state for a report, defaulting to 'unknown' when there is no report. */
function stateFor(report) {
  return STATE_UI[report && report.state] || 'unknown';
}

/** The report's own badge, falling back to the generic label for unknown. */
function badgeFor(report) {
  return (report && report.badge) || STATE_LABEL[(report && report.state) || 'unknown'];
}

function badgeClass(report) {
  return stateFor(report);
}

/* ---------------- top bar ---------------- */

const GLOWS = {
  ok: { id: 'glowOk', cls: 'glow-ok' },
  bad: { id: 'glowBad', cls: 'glow-bad' },
  unknown: { id: 'glowWarn', cls: 'glow-warn' },
};

/**
 * Put text on the clipboard, and report whether it worked.
 *
 * The fallback is not defensive noise. This dashboard binds every interface, so it is
 * routinely opened from a LAN address over plain http:// — which is NOT a secure
 * context. There `navigator.clipboard` is undefined and `writeText` cannot be used at
 * all, so a feature built only on the async API works on localhost and silently fails
 * for most real users. The textarea + execCommand path is what makes copy work there.
 *
 * @returns {Promise<boolean>}
 */
async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      /* fall through to the legacy path */
    }
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  // Off-screen rather than hidden: a display:none element cannot be selected.
  ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  document.body.removeChild(ta);
  return ok;
}

/** Light the background glow that matches a CSS state. */
function applyGlow(ui) {
  for (const g of Object.values(GLOWS)) {
    const el = $(g.id);
    if (el) el.className = `glow ${g.cls}`;
  }
  const target = GLOWS[ui] || GLOWS.unknown;
  const el = $(target.id);
  if (el) el.className += ' on';
}

function syncPolicy(policy) {
  const el = $('policyLabel');
  if (!el || !policy) return;
  el.textContent = policy.expect === 'shown' ? 'نمایش قیمت' : 'پنهان بودن قیمت';
}

/** Keep the interval dropdown in step with what the server is really doing. */
function syncInterval(intervalMs) {
  if (!intervalMs) return;
  const sel = $('intervalSelect');
  if (!sel) return;
  const secs = String(Math.round(intervalMs / 1000));
  if (sel.value !== secs && [...sel.options].some((o) => o.value === secs)) sel.value = secs;
}

function setPill(ui, text, checking) {
  const pill = $('livePill');
  if (!pill) return;
  pill.dataset.state = checking ? 'loading' : ui;
  const label = $('livePillText');
  if (label) label.textContent = checking ? 'در حال بررسی…' : text;
}

/**
 * Light/dark switch, shared by all three pages.
 *
 * The `data-theme` attribute itself is set by a tiny inline script in each
 * page's <head>, before the stylesheet paints — otherwise a stored light choice
 * flashes a dark page on every load. This only handles the button.
 *
 * Until the visitor picks a side we keep following the system preference, and a
 * stored choice always wins: `wireThemeToggle` re-applies the resolved value on
 * every `matchMedia` change, and a listener added later can only ever be
 * dropped, never reordered ahead of a stored value.
 */
const THEME_KEY = 'usdt-monitor-theme';

function currentTheme() {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

function wireThemeToggle() {
  const btn = $('themeBtn');
  if (!btn) return;

  const label = () => {
    const on = currentTheme() === 'light';
    // A constant action label: naming the TARGET ("پوستهٔ روشن" while dark)
    // read as a state to half of the people who saw it. The button says what
    // it does; `aria-pressed` carries the state ("pressed" = light active).
    btn.textContent = 'تغییر پوسته';
    btn.setAttribute('aria-pressed', String(on));
    btn.setAttribute('aria-label', `تغییر پوسته (فعلاً: ${on ? 'روشن' : 'تیره'})`);
  };

  btn.addEventListener('click', () => {
    const next = currentTheme() === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      /* private mode: the toggle still works for this page view */
    }
    label();
  });

  // Follow the system only while there is no stored choice. Once the visitor
  // has chosen, their choice is the answer and the listener is dropped.
  if (window.matchMedia) {
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const onChange = (e) => {
      let stored = null;
      try {
        stored = localStorage.getItem(THEME_KEY);
      } catch {
        return;
      }
      if (stored === 'light' || stored === 'dark') return;
      document.documentElement.dataset.theme = e.matches ? 'light' : 'dark';
      label();
    };
    if (typeof mq.addEventListener === 'function') mq.addEventListener('change', onChange);
    else if (typeof mq.addListener === 'function') mq.addListener(onChange);
  }

  label();
}

/**
 * The off-canvas sidebar on small screens: the topbar's menu button opens it
 * over a dimmed backdrop; backdrop click, Esc, or picking a page closes it.
 */
function wireSidebar() {
  const btn = $('menuBtn');
  const side = $('sidebar');
  const backdrop = $('sideBackdrop');
  if (!btn || !side) return;

  const set = (open) => {
    side.classList.toggle('open', open);
    if (backdrop) backdrop.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
    document.body.classList.toggle('no-scroll', open);
  };

  btn.addEventListener('click', () => set(!side.classList.contains('open')));
  if (backdrop) backdrop.addEventListener('click', () => set(false));
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && side.classList.contains('open')) set(false);
  });
  side.addEventListener('click', (ev) => {
    if (ev.target.closest('a')) set(false);
  });
}

/** Wire the refresh button and the interval dropdown both pages share. */
function wireTopbar({ onRefresh }) {
  wireThemeToggle();
  wireSidebar();
  const btn = $('refreshBtn');
  if (btn && onRefresh) {
    btn.addEventListener('click', async () => {
      btn.classList.add('loading');
      btn.disabled = true;
      try {
        await onRefresh();
      } finally {
        btn.classList.remove('loading');
        btn.disabled = false;
      }
    });
  }

  const sel = $('intervalSelect');
  if (sel) {
    sel.addEventListener('change', async (e) => {
      await fetch('/api/interval', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ seconds: Number(e.target.value) }),
      });
    });
  }
}

/**
 * Countdown to the next scheduled check, refreshed by the caller's timer.
 * While a check is in flight the countdown is meaningless — the next cycle is
 * scheduled only once the current one has fully completed — so the slot says
 * exactly that instead of ticking toward a time nobody has committed to.
 */
function tickCountdown(nextAtIso, checking) {
  const el = $('metaNext');
  if (!el) return;
  if (checking) {
    el.textContent = 'پس از پایان بررسی…';
    return;
  }
  el.textContent = nextAtIso ? countdown(new Date(nextAtIso).getTime() - Date.now()) : '—';
}

/**
 * Time for a history row: the clock alone when the entry is from today, the
 * date in front of it otherwise — a bare ۱۴:۰۲ is unreadable for yesterday.
 */
function faTimeOrDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  if (d.toDateString() === new Date().toDateString()) return faTime(iso);
  const date = new Intl.DateTimeFormat('fa-IR-u-ca-persian', { month: 'short', day: 'numeric' }).format(d);
  return `${date}، ${faTime(iso)}`;
}

/**
 * Fill fraction for a progress bar: elapsed/avg, floored at 4% and capped
 * at 95% — the last 5% belongs to the completion signal, not to a guess.
 * One formula for both the ticker and the markup builder, so a bar rendered
 * mid-flight starts exactly where the ticker would put it.
 */
function progressPct(startedAtIso, avgMs) {
  const start = Date.parse(startedAtIso);
  const avg = Number(avgMs) || 12_000;
  if (!Number.isFinite(start)) return 4;
  return Math.max(4, Math.min(95, ((Date.now() - start) / avg) * 100));
}

/**
 * Live progress bars, ticked once a second from ONE shared interval.
 *
 * A bar carries its inputs as data attributes — `data-progress-start` (ISO)
 * and `data-progress-avg` (ms) — and this fills its inner bar to
 * elapsed/avg. Pages re-render on the 5s poll; the ticker only moves
 * widths between renders, so a checking card animates without churn.
 */
function tickProgressBars() {
  document.querySelectorAll('[data-progress-start]').forEach((el) => {
    const pct = progressPct(el.dataset.progressStart, el.dataset.progressAvg);
    const bar = el.querySelector('.progress-bar');
    if (bar) bar.style.width = pct.toFixed(1) + '%';
    if (el.getAttribute('role') === 'progressbar') {
      el.setAttribute('aria-valuenow', String(Math.round(pct)));
    }
  });
}
setInterval(tickProgressBars, 1000);

/**
 * Markup for one progress bar; width is driven by tickProgressBars. The fill
 * is born with its current width inline: the 5s poll re-renders the panel
 * around the bar, and a fresh element without an inline width would flash
 * the CSS default until the next tick — the bar snapping back to start and
 * gliding forward again on every poll. Amber is deliberate: it is the
 * colour this UI already uses for "in progress" (the loading pill, the
 * unknown stripe) — verdicts get the state colours, motion gets amber.
 */
function progressBarHtml(startedAtIso, avgMs, label) {
  const aria = label ? ` aria-label="${escapeHtml(label)}"` : '';
  const pct = progressPct(startedAtIso, avgMs);
  return `
    <div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(pct)}"${aria}
         data-progress-start="${escapeHtml(startedAtIso || '')}" data-progress-avg="${Number(avgMs) || 12_000}">
      <div class="progress-bar" style="width:${pct.toFixed(1)}%"></div>
    </div>
    ${label ? `<span class="progress-label">${escapeHtml(label)}</span>` : ''}`;
}

/**
 * Mini timeline of an exchange's last verdicts, for a dashboard card. Rendered
 * in an RTL row, so the first cell (newest) sits at the right edge. Each cell
 * carries the verdict and its time as a tooltip; the strip announces itself to
 * screen readers as one summary instead of a dozen empty spans.
 */
function stateStripHtml(states) {
  if (!states || !states.length) return '';
  const cells = states
    .map((it) => {
      const cls = it.s === 'compliant' ? 'ok' : it.s === 'violation' ? 'bad' : 'warn';
      return `<span class="strip-cell ${cls}" aria-hidden="true" title="${escapeHtml(
        (STATE_LABEL[it.s] || it.s) + ' — ' + faTimeOrDate(it.t)
      )}"></span>`;
    })
    .join('');
  const summary = states
    .slice(0, 3)
    .map((it) => STATE_LABEL[it.s] || it.s)
    .join('، ');
  return `<div class="state-strip" role="img" aria-label="بررسی‌های اخیر: ${escapeHtml(summary)}">${cells}</div>`;
}

/** History rows are rendered the same way on both pages. */
function historyRow(entry, nameOf) {
  const label =
    entry.state === 'compliant' ? 'رعایت دستور' : entry.state === 'violation' ? 'تخلف' : 'نامشخص';
  const cls = entry.state === 'compliant' ? 'ok' : entry.state === 'violation' ? 'bad' : 'warn';
  const price = entry.priceVisible ? (entry.price ? num(entry.price) : '—') : 'منتشر نشد';
  const note = entry.flash ? 'نمایش لحظه‌ای هنگام بارگذاری' : '—';
  return `
    <tr>
      <td class="num" title="${escapeHtml(faDateTime(entry.checkedAt))}">${faTimeOrDate(entry.checkedAt)}</td>
      ${nameOf ? `<td>${escapeHtml(nameOf(entry))}</td>` : ''}
      <td><span class="badge ${cls}">${label}</span></td>
      <td class="num">${price}</td>
      <td class="${entry.flash ? 'flash' : ''}">${note}</td>
    </tr>`;
}

function renderHistoryRows(entries, nameOf) {
  const tbody = $('logBody');
  const tag = $('historyTag');
  if (!entries.length) {
    tbody.innerHTML = `<tr class="empty"><td colspan="${nameOf ? 5 : 4}">هنوز بررسی‌ای انجام نشده است.</td></tr>`;
    if (tag) tag.textContent = '—';
    return;
  }
  tbody.innerHTML = entries.map((e) => historyRow(e, nameOf)).join('');
  if (tag) tag.textContent = fa(entries.length) + ' بررسی اخیر';
}