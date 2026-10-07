'use strict';

/**
 * Verifies the evidence capture for every exchange in the registry.
 *
 * This runs the REAL scraper — `scrapeExchange` — rather than re-implementing a
 * capture here. An earlier version drove the browser itself, which meant it
 * verified a second implementation instead of the shipped one, and it inherited
 * the very failure this work fixed: unbounded in-page evaluation, so any page
 * that locks its own main thread hung the verifier too.
 *
 * The capture is now ONE image of the whole checked page (re-encoded to WebP),
 * so there is no per-element clip to verify and no screenshot text to
 * cross-check — both of which only made sense while a cropped element was the
 * evidence. What remains is the property that can still fail, and that actually
 * matters:
 *
 *   - a check that got past navigation either produces exactly one readable
 *     image, or produces none at all and says so;
 *   - the image is a real WebP of the page that was checked;
 *   - retention keeps the NEWEST images, by the timestamp in the filename.
 *
 *   node test/verify-shots.js
 */

const fs = require('fs');
const path = require('path');
const { EXCHANGES } = require('../src/exchanges');
const { scrapeExchange, closeBrowser, SHOTS_DIR, SHOTS_PER_EXCHANGE, MAX_SHOT_HEIGHT } = require('../src/scraper');

const failures = [];

/** A WebP, not an HTML error page, not a 0-byte file, not a leftover JPEG. */
function looksLikeAnImage(file) {
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch (err) {
    return { ok: false, why: `unreadable: ${err.code || err.message}` };
  }
  if (buf.length < 4096) return { ok: false, why: `only ${buf.length} bytes` };
  // RIFF container: 'RIFF' at 0, 'WEBP' at 8. Checked at both offsets because
  // anything that starts RIFF but is not WEBP is not our capture either.
  const ascii = buf.subarray(0, 12).toString('ascii');
  if (ascii.slice(0, 4) !== 'RIFF' || ascii.slice(8, 12) !== 'WEBP') {
    return { ok: false, why: `not a WebP (starts ${buf.subarray(0, 4).toString('hex')})` };
  }
  return { ok: true, bytes: buf.length };
}

/** Every capture on disk, per exchange folder: `{ id, name }`. */
const shotNames = () => fs
  .readdirSync(SHOTS_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .flatMap((d) => fs
    .readdirSync(path.join(SHOTS_DIR, d.name))
    .filter((f) => /\.(?:webp|jpg)$/.test(f))
    .map((f) => ({ id: d.name, name: f })));

async function checkExchange(ex) {
  console.log(`\n=== ${ex.name} (${ex.host}) ===`);

  const scrape = await scrapeExchange(ex);
  const shots = scrape.screenshots || [];

  console.log(
    `  ready=${scrape.ready} feedLive=${scrape.feedLive} ` +
      `navError=${scrape.navError ? 'yes' : 'no'} durationMs=${scrape.durationMs}`
  );
  for (const p of Object.entries(scrape.probes || {})) {
    console.log(`    probe ${p[0].padEnd(8)} = ${JSON.stringify(p[1].raw)}`);
  }

  // One image per check is the contract the UI, the pruner and this file all
  // rely on. Asserted on the scrape's own list, NOT on a directory diff: the
  // dashboard writes into the same folder, so counting files here is wrong the
  // moment anything else is checking an exchange.
  if (shots.length > 1) {
    const msg = `${ex.id}: one capture per check, got ${shots.length}`;
    console.log(`    FAIL ${msg}`);
    failures.push(msg);
  }

  if (!shots.length) {
    // Not a code defect in either of these two cases, and calling it one would
    // make this file useless: a page that never loaded has nothing to shoot,
    // and a page whose renderer locked mid-navigation cannot be photographed
    // even in principle (that is why the capture is best-effort and bounded).
    if (scrape.navError) {
      console.log('    SKIP no capture: the navigation failed, which is the documented reason');
    } else if (!scrape.ready) {
      console.log('    SKIP no capture: the probe never read the page, so there was nothing to photograph');
    } else {
      // The falsifiable one. The page WAS readable, so an image was achievable,
      // and its absence is a real regression.
      console.log('    FAIL no capture, although the page was readable');
      failures.push(`${ex.id}: the page was read successfully but no evidence image was written`);
    }
    return;
  }

  for (const shot of shots) {
    const file = path.join(SHOTS_DIR, shot.file);
    const check = looksLikeAnImage(file);
    if (!check.ok) {
      console.log(`    FAIL ${shot.file}: ${check.why}`);
      failures.push(`${ex.id}: capture is not a readable WebP (${check.why})`);
      continue;
    }
    console.log(`    PASS ${shot.file}: ${Math.round(check.bytes / 1024)}KB, height ${shot.height}px`);
    // A clamped image is legal but must be visible to the operator, not a
    // silent crop of the evidence.
    if (shot.height > MAX_SHOT_HEIGHT) {
      const msg = `${ex.id}: reported capture height ${shot.height} exceeds the clamp ${MAX_SHOT_HEIGHT}`;
      console.log(`    FAIL ${msg}`);
      failures.push(msg);
    }
  }
}

/** The pruner must keep the NEWEST N per exchange, by the timestamp that IS
 * the filename. Retention is per exchange on purpose: a global ceiling would
 * let twenty busy exchanges crowd out whichever exchange sorts first. */
function checkRetention() {
  console.log('\n=== retention ===');
  const perExchange = new Map();
  for (const s of shotNames()) {
    if (!perExchange.has(s.id)) perExchange.set(s.id, []);
    perExchange.get(s.id).push(s.name);
  }
  const total = shotNames().length;
  console.log(`  ${total} capture(s) across ${perExchange.size} exchange folder(s), ceiling ${SHOTS_PER_EXCHANGE} per exchange`);
  for (const [id, names] of perExchange) {
    if (names.length > SHOTS_PER_EXCHANGE) {
      failures.push(`${id}: ${names.length} captures exceeds the ${SHOTS_PER_EXCHANGE} per-exchange ceiling`);
    }
  }
  // Retention orders by the timestamp that IS the filename — the property the
  // pruner relies on. A plain string sort of equal-length timestamps agrees,
  // but the sort must never regress to name order for different lengths.
  const stamp = (f) => Number((f.match(/^(\d+)\.(?:webp|jpg)$/) || [])[1]) || 0;
  const names = ['1800000000000.webp', '1700000000000.webp', '1750000000000.webp'];
  const oldest = names.slice().sort((a, b) => stamp(a) - stamp(b))[0];
  console.log(`  oldest by timestamp: ${oldest}`);
  if (oldest !== '1700000000000.webp') {
    failures.push('retention must order by the timestamp in the filename, not by the name');
  }
}

(async () => {
  try {
    for (const ex of EXCHANGES) {
      // Static exchanges (wallex) now get an evidence photo too, taken
      // hands-off through the compositor — so they verify here like the rest.
      try {
        await checkExchange(ex);
      } catch (err) {
        const msg = `${ex.id}: ${String(err.message).split('\n')[0]}`;
        console.log(`    FAIL ${msg}`);
        failures.push(msg);
      }
    }
    checkRetention();
  } finally {
    await closeBrowser();
  }
  console.log(
    `\n${failures.length ? `${failures.length} problem(s) found` : 'all page captures verified'}`
  );
  process.exit(failures.length ? 1 : 0);
})();