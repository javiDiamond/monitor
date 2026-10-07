'use strict';

/* Detail page for a single exchange. The id comes from /exchange/:id. */

/* global $, fa, num, faTime, faDateTime, relative, parseNum, escapeHtml,
   STATE_LABEL, stateFor, badgeFor, applyGlow, syncPolicy, syncInterval,
   setPill, wireTopbar, tickCountdown, renderHistoryRows, progressBarHtml */

const exchangeId = decodeURIComponent(location.pathname.split('/').filter(Boolean)[1] || '');

let nextAt = null;
let lastProbeSig = null;
let lastShotSig = null;
/* When this exchange's check was first seen running — the clock the hero
 * progress bar runs on, accurate to the 5-second data poll. */
let checkingSince = null;

/* ---------------- rendering ---------------- */

function render(data) {
  const r = data.report;
  const st = data.stats;
  const ui = stateFor(r);

  nextAt = data.nextCheckAt;
  syncPolicy(data.policy);
  syncInterval(data.intervalMs);

  applyGlow(ui);

  setPill(
    ui,
    r.state === 'violation'
      ? 'تخلف — قیمت نمایش داده شد'
      : r.state === 'unknown'
        ? 'وضعیت نامشخص'
        : 'دستور رعایت شده است',
    data.checking
  );

  document.title = `${data.name} — پایش قیمت تتر`;

  const hero = $('hero');
  hero.dataset.state = data.checking && !r ? 'loading' : ui;

  $('heroTitle').textContent = r ? r.title : 'در انتظار اولین بررسی…';
  $('heroDesc').textContent = r ? r.description : 'لطفاً چند لحظه صبر کنید تا این صرافی بررسی شود.';
  // While this exchange's check runs, the verdict on screen belongs to the
  // PREVIOUS evaluation — the badge must not quietly assert it as current.
  $('heroBadge').textContent = data.checking ? 'در حال بررسی…' : badgeFor(r);

  // Prev/next within the watchlist, so an operator can walk the exchanges
  // without going back to the grid between each one.
  const nb = $('exNeighbours');
  if (nb && data.neighbours) {
    const wire = (id, n, make) => {
      const a = $(id);
      if (!a) return;
      if (!n) { a.hidden = true; return; }
      a.href = `/exchange/${encodeURIComponent(n.id)}`;
      a.textContent = make(n.name);
      a.hidden = false;
    };
    wire('neighbourPrev', data.neighbours.prev, (name) => `→ ${name}`);
    wire('neighbourNext', data.neighbours.next, (name) => `${name} ←`);
    nb.hidden = !data.neighbours.prev && !data.neighbours.next;
  }

  // The price block renders only in the violation state. The unit comes from
  // the exchange, because not every site quotes in Toman.
  const priceBox = $('priceBox');
  if (r && r.priceVisible && r.price) {
    priceBox.hidden = false;
    $('priceValue').textContent = r.price.formatted;
    $('priceUnit').textContent = r.price.unit || 'تومان';
  } else {
    priceBox.hidden = true;
  }

  const flash = $('flashNote');
  if (r && r.flashNote) {
    flash.hidden = false;
    $('flashText').textContent = r.flashNote;
  } else {
    flash.hidden = true;
  }

  $('metaName').textContent = data.name;
  $('metaHost').textContent = data.host;

  // The page the price is read from. This is the adapter's monitored URL — the
  // effective one, after any EXCHANGE_URL_<ID> override — and it is the same
  // page every probe row below was extracted from, so the evidence is anchored
  // to a location a person can open themselves.
  const urlEl = $('metaUrl');
  if (urlEl && data.url) {
    const a = document.createElement('a');
    a.href = data.url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.className = 'mono';
    a.textContent = data.url;
    urlEl.textContent = '';
    urlEl.appendChild(a);
  }

  // When the public page would not load and a backup surface answered instead,
  // name that surface too — the verdict came from somewhere else.
  const fbRow = $('metaFallback');
  if (fbRow) {
    const fb = data.report && data.report.usedFallback;
    if (fb) {
      fbRow.hidden = false;
      const a = document.createElement('a');
      a.href = fb.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.className = 'mono';
      a.textContent = fb.url;
      const v = fbRow.querySelector('.meta-v');
      v.textContent = '';
      v.appendChild(document.createTextNode(`${fb.label}: `));
      v.appendChild(a);
    } else {
      fbRow.hidden = true;
    }
  }
  $('metaChecked').textContent = r ? `${faDateTime(r.checkedAt)} (${relative(r.checkedAt)})` : '—';
  tickCountdown(nextAt, data.checkingGlobal);

  // The per-exchange progress bar: rendered while THIS exchange's check runs,
  // timed from our first sighting of the checking flag against the exchange's
  // own average duration. Gone the moment a verdict arrives.
  const heroProgress = $('heroProgress');
  const avgMs = (data.stats && data.stats.avgDurationMs) || 12_000;
  if (data.checking) {
    if (!checkingSince) checkingSince = new Date().toISOString();
    heroProgress.hidden = false;
    heroProgress.innerHTML = progressBarHtml(checkingSince, avgMs, 'در حال بررسی این صرافی…');
  } else {
    checkingSince = null;
    heroProgress.hidden = true;
    heroProgress.innerHTML = '';
  }

  renderStats(st);
  renderProbes(r);
  renderShots(r);
  renderHistoryRows(data.history || [], null);
}

function renderStats(st) {
  const rate = st.compliancePercent;
  const rateEl = $('statCompliance');
  if (rate == null) {
    rateEl.textContent = '—';
    rateEl.className = 'stat-value';
  } else {
    rateEl.textContent = fa(rate.toFixed(1)) + '٪';
    rateEl.className = 'stat-value ' + (rate >= 99 ? 'ok' : rate > 0 ? 'warn' : 'bad');
  }
  $('statComplianceHint').textContent =
    `${fa(st.compliantChecks)} رعایت • ${fa(st.violationChecks)} تخلف • ${fa(st.unknownChecks)} نامشخص`;

  const v = $('statViolations');
  v.textContent = st.violationChecks ? fa(st.violationChecks) : 'بدون تخلف';
  v.className = 'stat-value ' + (st.violationChecks ? 'bad' : 'ok');
  $('statViolationsHint').textContent = st.currentStateSince
    ? `وضعیت فعلی از ${relative(st.currentStateSince)} است`
    : '—';

  const lv = $('statLastViolation');
  if (st.lastViolationAt) {
    lv.textContent = relative(st.lastViolationAt);
    lv.className = 'stat-value bad';
    $('statLastViolationHint').textContent = `در ${faDateTime(st.lastViolationAt)}`;
  } else {
    lv.textContent = 'ثبت نشده';
    lv.className = 'stat-value ok';
    $('statLastViolationHint').textContent = 'تا این لحظه هیچ تخلفی مشاهده نشده است';
  }

  $('statDuration').textContent =
    st.avgDurationMs != null ? `${fa((st.avgDurationMs / 1000).toFixed(1))} ثانیه` : '—';
}

/** Every place on the page where the price could have appeared. */
function renderProbes(r) {
  const list = $('probeList');
  const tag = $('probeTag');

  // Only rebuild when something changed — the page polls every few seconds and
  // rewriting unchanged DOM causes flicker.
  const sig = JSON.stringify([
    r && r.checkedAt, r && r.detail, r && r.api, r && r.probes, r && r.titlePrice,
  ]);
  if (sig === lastProbeSig) return;
  lastProbeSig = sig;

  if (!r || (!Object.keys(r.probes || {}).length && !r.titlePrice)) {
    list.innerHTML = '<p class="ex-desc">هنوز داده‌ای برای نمایش وجود ندارد.</p>';
    tag.textContent = '—';
    // `detail` carries the actionable half of a failed check — the exact install
    // command when the browser would not start. A browserError report has no
    // probes by construction, so returning here without rendering it hid the only
    // actionable line on the very page an operator opens to investigate a
    // «نامشخص» verdict.
    renderDetail(r && r.detail);
    return;
  }

  const rows = Object.entries(r.probes).map(([key, p]) => {
    const n = parseNum(p.raw);
    // A price that exists in the DOM but is off-screen or clipped is neither a
    // violation nor clean compliance — mark it so the operator can see why.
    const hiddenPrice = n > 0 && p.visible === false;
    const cls = hiddenPrice ? 'warn' : n > 0 ? 'ok' : p.raw == null || p.raw === '' ? 'dim' : 'hidden';
    const shown = hiddenPrice ? num(n) : n > 0 ? num(n) : p.raw == null || p.raw === '' ? 'خالی' : `«${escapeHtml(p.raw)}»`;
    const note = hiddenPrice ? ' <span class="vis-note">در صفحه هست ولی دیده نمی‌شود</span>' : '';
    return `<div class="ex-probe">
      <span class="ex-probe-k">${escapeHtml(p.label)}</span>
      <span class="ex-probe-v ${cls} mono">${shown}${note}</span>
    </div>`;
  });

  const api = r.api && r.api.price
    ? `<div class="ex-probe ex-api">
        <span class="ex-probe-k">قیمت در API عمومی صرافی</span>
        <span class="ex-probe-v warn mono">${num(r.api.price)} تومان</span>
      </div>`
    : '';

  // The browser tab's own title. Rendered as one extra read-only row, clearly
  // labelled, because no page element holds it — and because it is a finding
  // that never reaches the verdict. Deliberately NOT counted in `probeTag`:
  // it is not one of the page's surfaces.
  const title = r.titlePrice
    ? `<div class="ex-probe ex-title">
        <span class="ex-probe-k">عنوان صفحه (سربرگ مرورگر)</span>
        <span class="ex-probe-v warn mono">${num(r.titlePrice.value)} ${escapeHtml(r.titlePrice.unit)}</span>
      </div>`
    : '';

  list.innerHTML = rows.join('') + api + title;
  tag.textContent = `${fa(Object.keys(r.probes).length)} محل بررسی شد`;
  renderDetail(r.detail);
}

/**
 * The technical detail note — for the facts NOTHING else on the page shows.
 *
 * The server only sets `detail` when it carries information the probe rows do
 * not: the browser-install hint on a browser-unavailable verdict, the raw
 * navigation error, the visibility-check failure, a check timeout. Everything
 * else (the per-surface readings, HTTP statuses already quoted in the
 * description) is deliberately not sent, so this section simply stays hidden
 * unless there is genuinely new information here.
 */
function renderDetail(detail) {
  const note = $('detailNote');
  const body = $('detailNoteBody');
  if (!note || !body) return;

  const text = (detail || '').trim();
  if (!text) {
    note.hidden = true;
    return;
  }
  note.hidden = false;
  body.textContent = '';

  const span = document.createElement('span');
  // A command or a status reads better left-to-right; Persian prose must not
  // be touched.
  if (/^[\x20-\x7E]+$/.test(text)) span.className = 'note-code';
  span.textContent = text;
  body.appendChild(span);
}

function renderShots(r) {
  const panel = $('shotPanel');
  const shots = (r && r.screenshots) || [];

  const sig = JSON.stringify(shots.map((s) => s.url));
  if (sig === lastShotSig) return;
  lastShotSig = sig;

  // The archive link is always offered once a report exists: even a check that
  // produced no capture this time may have older evidence kept in
  // shots/<exchangeId>/ and shown on the /screenshots page.
  const archive = $('shotsArchive');
  if (archive) {
    archive.href = `/screenshots?ex=${encodeURIComponent(exchangeId)}`;
    archive.hidden = !r;
  }

  if (!shots.length) {
    $('shotList').innerHTML = '';
    panel.hidden = !r; // keep the panel (and its archive link) when a report exists
    return;
  }
  panel.hidden = false;
  const v = Date.parse(r.checkedAt) || 0;
  $('shotList').innerHTML = shots
    .map(
      (s) => `<div class="shot">
        <span class="shot-label">${escapeHtml(s.label)}</span>
        <img src="${escapeHtml(s.url)}?v=${v}" alt="${escapeHtml(s.label)}" />
      </div>`
    )
    .join('');
  // The capture height goes in the tag next to the timestamp, so a clamped
  // image — one that stops short of the bottom of the page — is obvious rather
  // than silently cropping the evidence.
  const shot = shots[0];
  const h = shot.height ? ` • ${fa(shot.height.toLocaleString('en-US'))} پیکسل ارتفاع` : '';
  $('shotTag').textContent = `ثبت‌شده در ${faTime(r.checkedAt)}${h}`;
}

/* ---------------- data loop ---------------- */

async function load() {
  if (!exchangeId) return;
  try {
    const res = await fetch(`/api/exchange/${encodeURIComponent(exchangeId)}?limit=40`);
    if (!res.ok) return;
    render(await res.json());
  } catch (err) {
    // A silent catch here cost real time once: a throw inside render() made the
    // page sit on «در حال بررسی…» forever with nothing in the console. Surface it.
    console.error('exchange render failed:', err);
  }
}

wireTopbar({
  onRefresh: async () => {
    // Scoped to this exchange — the other exchanges are left alone.
    const res = await fetch(`/api/check/${encodeURIComponent(exchangeId)}`, { method: 'POST' });
    // A scheduled cycle already running means this check was refused. Say so
    // instead of flashing a spinner and leaving the user to wonder.
    if (res.status === 409) {
      const note = document.getElementById('refreshNote');
      if (note) {
        note.textContent = 'بررسی دیگری در جریان است؛ این صرافی در چرخهٔ جاری بررسی می‌شود.';
        note.hidden = false;
        setTimeout(() => { note.hidden = true; }, 6000);
      }
    }
    await load();
  },
});

load();
setInterval(load, 5000);
setInterval(() => tickCountdown(nextAt), 1000);