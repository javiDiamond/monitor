'use strict';

/* Evidence gallery: every kept screenshot per evaluation, per exchange.
 * Switching exchanges happens client-side (the URL still updates, so links
 * and back/forward behave); each card previews the price-hero region of the
 * capture and can expand to the full page; a lightbox walks the evaluations
 * with the keyboard. Shots come from /api/exchange/:id/shots, each already
 * joined to the verdict of the check that produced it. */

/* global $, fa, num, faDateTime, relative, escapeHtml, STATE_LABEL, wireTopbar */

const params = new URLSearchParams(location.search);
let current = params.get('ex') || '';
let lastSig = null;
/* Filtered + loaded shots, in gallery order (newest first) — the lightbox
 * walks this array. */
let visibleShots = [];

/* ---------------- exchange switching (client-side) ---------------- */

function renderChips(exchanges) {
  $('exChips').innerHTML = exchanges.map((e) =>
    `<button type="button" class="chip ${e.id === current ? 'active' : ''}" data-ex="${escapeHtml(e.id)}">${escapeHtml(e.name)}</button>`
  ).join('');
}

function pickExchange(id, { push = true } = {}) {
  if (!id || id === current) return;
  current = id;
  lastSig = null;
  document.querySelectorAll('#exChips .chip').forEach((c) => {
    c.classList.toggle('active', c.dataset.ex === current);
  });
  if (push) history.replaceState(null, '', `/screenshots?ex=${encodeURIComponent(current)}`);
  loadShots();
}

/* ---------------- gallery ---------------- */

/** Keep only shots inside the selected window. */
function withinWindow(shot) {
  const days = Number(document.getElementById('windowFilter').value) || 0;
  if (!days) return true;
  return Date.now() - Date.parse(shot.checkedAt) <= days * 86_400_000;
}

async function loadShots() {
  if (!current) return;
  let data;
  try {
    const res = await fetch(`/api/exchange/${encodeURIComponent(current)}/shots`);
    data = await res.json();
  } catch (err) {
    console.error('shots load failed:', err);
    return;
  }
  const shots = (data.shots || []).filter(withinWindow);
  visibleShots = shots;

  const sig = JSON.stringify([shots.map((s) => s.url), document.getElementById('windowFilter').value]);
  if (sig === lastSig) return;
  lastSig = sig;

  $('shotCount').textContent = shots.length ? `${fa(shots.length)} ثبت اخیر` : '—';

  if (!shots.length) {
    $('gallery').innerHTML = '<div class="card panel empty-filter">در این بازه شواهدی برای این صرافی ثبت نشده است.</div>';
    return;
  }

  $('gallery').innerHTML = shots.map((s, i) => {
    const cls = s.state === 'compliant' ? 'ok' : s.state === 'violation' ? 'bad' : 'warn';
    const label = s.state ? STATE_LABEL[s.state] || s.state : 'نامشخص';
    const price = s.priceVisible && s.price
      ? `<span class="ex-card-price bad">${num(s.price)} تومان</span>`
      : `<span class="ex-card-price hidden">قیمت منتشر نشد</span>`;
    const flash = s.flash ? '<span class="flash-tag">نمایش لحظه‌ای هنگام بارگذاری</span>' : '';
    // The capture is dominated by a full page of unchanged content; the card
    // previews the top (price-hero) region and expands on demand.
    return `<div class="card shot-card" data-index="${i}">
      <div class="shot-card-head">
        <span class="shot-when">${faDateTime(s.checkedAt)} <span class="shot-ago">(${relative(s.checkedAt)})</span></span>
        <span class="badge ${cls}">${escapeHtml(label)}</span>
      </div>
      <button type="button" class="shot-preview" data-open="${i}" title="نمایش در اندازهٔ کامل" aria-label="نمایش کامل این شواهد">
        <img loading="lazy" src="${escapeHtml(s.url)}" alt="شواهد صفحهٔ ${escapeHtml(data.name || '')} در ${escapeHtml(s.checkedAt)}" />
      </button>
      <div class="shot-card-foot">
        ${price}${flash}
        <button type="button" class="shot-expand" data-expand="${i}">نمایش کل صفحه</button>
      </div>
    </div>`;
  }).join('');
}

/** A card's preview flips between the hero crop and the whole page. */
function toggleExpand(btn) {
  const card = btn.closest('.shot-card');
  const expanded = card.classList.toggle('expanded');
  btn.textContent = expanded ? 'نمایش بخش قیمت' : 'نمایش کل صفحه';
}

/* ---------------- lightbox ---------------- */

function renderLightbox() {
  const box = $('lightbox');
  const shot = visibleShots[lightboxIndex];
  if (!shot) return;
  $('lightboxImg').src = shot.url;
  $('lightboxCaption').textContent = faDateTime(shot.checkedAt);
  $('lightboxState').textContent = shot.state ? STATE_LABEL[shot.state] || shot.state : 'نامشخص';
  $('lightboxPos').textContent = `${fa(lightboxIndex + 1)} از ${fa(visibleShots.length)}`;
  $('lightboxPrev').disabled = lightboxIndex >= visibleShots.length - 1;
  $('lightboxNext').disabled = lightboxIndex <= 0;
  box.hidden = false;
  document.body.classList.add('no-scroll');
}

function openLightbox(i) {
  if (i < 0 || i >= visibleShots.length) return;
  lightboxIndex = i;
  renderLightbox();
}

function closeLightbox() {
  lightboxIndex = -1;
  $('lightbox').hidden = true;
  document.body.classList.remove('no-scroll');
}

function stepLightbox(delta) {
  const next = lightboxIndex + delta;
  if (next < 0 || next >= visibleShots.length) return;
  lightboxIndex = next;
  renderLightbox();
}

let lightboxIndex = -1;

/* ---------------- wiring ---------------- */

wireTopbar({});

async function loadExchanges() {
  try {
    const res = await fetch('/api/status');
    const data = await res.json();
    const exchanges = data.exchanges || [];
    if (!current || !exchanges.some((e) => e.id === current)) {
      current = exchanges.length ? exchanges[0].id : '';
    }
    renderChips(exchanges);
    const cur = exchanges.find((e) => e.id === current);
    if (cur) $('galleryTitle').textContent = `شواهد تصویری — ${cur.name}`;
    // The live pill in this page's topbar: monitoring state at a glance.
    const pill = $('livePill');
    if (pill) {
      pill.dataset.state = data.checking ? 'loading' : 'ok';
      $('livePillText').textContent = data.checking ? 'در حال بررسی…' : 'پایش فعال';
    }
    // The default exchange is now known — the gallery can load. This is the
    // only path that loads on first visit (there is no ?ex= in the URL yet,
    // so an early loadShots() call would bail on an empty `current`); on the
    // later polls it re-runs harmlessly behind the signature guard.
    await loadShots();
  } catch (err) {
    console.error('shots page: exchange list failed:', err);
  }
}

$('exChips').addEventListener('click', (ev) => {
  const btn = ev.target.closest('[data-ex]');
  if (btn) pickExchange(btn.dataset.ex, { push: true });
});

// Back/forward across gallery switches.
window.addEventListener('popstate', () => {
  const id = new URLSearchParams(location.search).get('ex');
  if (id) pickExchange(id, { push: false });
});

$('windowFilter').addEventListener('change', () => {
  lastSig = null;
  loadShots();
});

$('gallery').addEventListener('click', (ev) => {
  const open = ev.target.closest('[data-open]');
  if (open) { openLightbox(Number(open.dataset.open)); return; }
  const expand = ev.target.closest('[data-expand]');
  if (expand) toggleExpand(expand);
});

$('lightbox').addEventListener('click', (ev) => {
  if (ev.target.closest('[data-close]')) { closeLightbox(); return; }
  if (ev.target.closest('#lightboxPrev')) { stepLightbox(1); return; }
  if (ev.target.closest('#lightboxNext')) { stepLightbox(-1); return; }
  if (ev.target === $('lightbox')) closeLightbox();
});

document.addEventListener('keydown', (ev) => {
  if ($('lightbox').hidden) return;
  if (ev.key === 'Escape') closeLightbox();
  if (ev.key === 'ArrowLeft') stepLightbox(1);   // RTL: left walks to older shots
  if (ev.key === 'ArrowRight') stepLightbox(-1); // RTL: right walks to newer shots
});

loadExchanges();
// The poll also re-resolves the default exchange first, so a first visit that
// landed while the server was restarting recovers on its own.
setInterval(loadExchanges, 30_000);
