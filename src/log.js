'use strict';

/**
 * Execution log: what actually happened during checks, so a «وضعیت نامشخص» can
 * be explained instead of guessed at.
 *
 * Three levels, in rising severity:
 *
 *   info  — a check completed, a state changed, a screenshot was captured
 *   warn  — something completed but the result is untrustworthy: an HTTP status
 *           outside 2xx, a price that flashed during load, an unusually slow check
 *   error — the check could not be completed at all: navigation failed, the
 *           scraper threw
 *
 * The buffer is a ring: the oldest entries fall off once MAX is reached, so the
 * page always shows recent history without the buffer growing forever. Lifetime
 * per-level counters are kept separately and never decremented, so "how many
 * errors have there ever been" survives even after entries age out.
 *
 * Each entry carries two kinds of context. The flat keys (exchangeId, code,
 * httpStatus, durationMs, url, hint) are what the table renders and filters on.
 * `meta` is the debugging payload underneath: the readings a verdict came from,
 * which cycle produced it, the resolved policy, and a classified network error.
 * It is shown in an expandable row and carried by the copy actions, which is what
 * makes "why did this exchange go نامشخص" answerable from the log page alone.
 *
 * Everything here is in-process only. Nothing is written to disk, and restarting
 * the server clears the log — the same lifetime as the statistics, and
 * deliberate: this is a live operations view, not an archive. `clear()` empties
 * the view but deliberately leaves the lifetime counters alone; they answer
 * "since the process started", which a view reset should not rewrite.
 */

const MAX = 600;
const LEVELS = ['info', 'warn', 'error'];

/** Caps applied to `meta` so a fat probe value cannot grow the ring without limit. */
const META_STRING_CAP = 160;
const META_ARRAY_CAP = 20;
const META_KEY_CAP = 40;
const META_DEPTH_CAP = 3;

/** Newest last, so slicing off the head drops the oldest. */
const entries = [];

/** Lifetime counters, one per level. Never decremented. */
const lifetime = { info: 0, warn: 0, error: 0 };

/**
 * Monotonic per-entry id. Stable across re-fetches and across the ring dropping the
 * oldest entries, so the log page can remember which rows the operator expanded even
 * though the table is rebuilt on every poll. `ts` alone is not unique enough — one
 * check fans out to several pushes that can land in the same millisecond.
 */
let seq = 0;

/**
 * Turn an arbitrary debug object into something bounded and storable.
 *
 * The ring holds 600 entries and never shrinks, so unbounded metadata would be a slow
 * leak. Strings are capped because a single probe `raw` can be a whole page of digits;
 * arrays and objects are capped because a probe map can hold a dozen keys. Depth 3 is
 * exactly enough for the nested `probes[key]{raw, visible, primary}` shape that is the
 * deepest thing the monitor records.
 *
 * Values the JSON API cannot represent are dropped rather than stringified: an
 * `undefined` field is noise, and `"[object Object]"` is worse than nothing.
 */
function sanitiseMeta(value, depth = 0) {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string') {
    return value.length > META_STRING_CAP ? `${value.slice(0, META_STRING_CAP - 1)}…` : value;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'boolean') return value;
  // Functions, symbols and anything else have no useful JSON form.
  if (typeof value !== 'object') return undefined;
  if (depth >= META_DEPTH_CAP) return '…';

  if (Array.isArray(value)) {
    const out = [];
    for (const item of value.slice(0, META_ARRAY_CAP)) {
      const clean = sanitiseMeta(item, depth + 1);
      if (clean !== undefined) out.push(clean);
    }
    return out;
  }

  const out = {};
  let kept = 0;
  for (const [key, val] of Object.entries(value)) {
    if (kept >= META_KEY_CAP) break;
    const clean = sanitiseMeta(val, depth + 1);
    if (clean !== undefined) {
      out[key] = clean;
      kept += 1;
    }
  }
  return out;
}

/**
 * Sort a navigation failure into the categories an operator actually acts on.
 *
 * "صفحه باز نشد" cannot distinguish four very different problems: the host has no route
 * to the exchange, DNS is blocked, the exchange refused us, or the page was too slow.
 * Two vocabularies carry that distinction and both are already available: the
 * `net::ERR_*` token Playwright embeds in a browser navigation message, and Node's
 * `err.cause.code` on the static fetch path. Without the second one the browser-free
 * exchanges were stuck reporting the literal string "fetch failed" for every one of
 * those causes.
 *
 * An unrecognised input yields `unknown` and a null code — this never guesses.
 *
 * @param {string} msg    The raw navigation error message.
 * @param {string} [code] Node's own cause code, when the failure came from fetch().
 * @returns {{netErr: string|null, kind: string}}
 */
function classifyNavError(msg, code) {
  const raw = String(msg == null ? '' : msg);
  const netErr = (raw.match(/net::ERR_[A-Z_]+/) || [null])[0];

  let kind = 'unknown';
  if (/timeout \d+ms exceeded/i.test(raw)) kind = 'timeout';
  else if (!netErr && !code) kind = 'unknown';
  else if (netErr && /ERR_(NAME_NOT_RESOLVED|DNS|NAME_RESOLUTION_FAILED)/.test(netErr)) kind = 'dns';
  else if (netErr && /ERR_INTERNET_DISCONNECTED|NETWORK_CHANGED|NETWORK_IO_SUSPENDED/.test(netErr)) kind = 'offline';
  else if (netErr && /ERR_CERT|ERR_SSL|ERR_BAD_SSL/.test(netErr)) kind = 'tls';
  else if (netErr && /ERR_CONNECTION_(REFUSED|RESET|CLOSED|FAILED|ABORTED)/.test(netErr)) kind = 'connection';
  else if (netErr) kind = 'net';
  // No usable net::ERR_ token, so fall back to the fetch-path vocabulary.
  else if (/^(ENOTFOUND|EAI_AGAIN)$/.test(code)) kind = 'dns';
  else if (/^(ECONNREFUSED|ECONNRESET|EPIPE|UND_ERR_SOCKET)$/.test(code)) kind = 'connection';
  else if (/^(ETIMEDOUT|UND_ERR_(CONNECT|HEADERS|BODY)_TIMEOUT|UND_ERR_SOCKET)$/.test(code)) kind = 'timeout';
  else if (/CERT|SSL|SELF_SIGNED|LEAF_SIGNATURE/i.test(String(code))) kind = 'tls';

  return { netErr, kind };
}

/**
 * Record one log entry.
 *
 * @param {'info'|'warn'|'error'} level
 * @param {string} message   Human-readable, Persian, ready to render as-is.
 * @param {object} [detail]  Optional context: exchangeId, exchangeName, code,
 *                           httpStatus, durationMs, url, hint, meta.
 */
function push(level, message, detail = {}) {
  if (!LEVELS.includes(level)) {
    throw new Error(`unknown log level: ${level}`);
  }
  lifetime[level] += 1;

  const entry = { seq: ++seq, ts: new Date().toISOString(), level, message };
  // `hint` is the actionable half of an environment failure — the command that
  // fixes it — so it is kept as structured context rather than only being buried
  // in the message string.
  for (const key of ['exchangeId', 'exchangeName', 'code', 'httpStatus', 'durationMs', 'url', 'hint']) {
    if (detail[key] !== undefined && detail[key] !== null) entry[key] = detail[key];
  }
  // `meta` is the debugging payload behind the expandable row and the copy/export
  // actions. It is stored as a sanitised COPY on purpose: one check fans out to
  // several log calls that share a common meta object, and holding the reference
  // would let a later per-call field retroactively rewrite an earlier entry.
  if (detail.meta && typeof detail.meta === 'object') {
    const clean = sanitiseMeta(detail.meta);
    if (clean && Object.keys(clean).length) entry.meta = clean;
  }

  entries.push(entry);
  if (entries.length > MAX) entries.splice(0, entries.length - MAX);

  return entry;
}

/**
 * Newest first.
 *
 * @param {{level?: string, exchangeId?: string, limit?: number}} [filter]
 */
function recent(filter = {}) {
  let list = entries;
  if (filter.level && LEVELS.includes(filter.level)) {
    list = list.filter((e) => e.level === filter.level);
  }
  if (filter.exchangeId) list = list.filter((e) => e.exchangeId === filter.exchangeId);
  const limit = Math.min(Number(filter.limit) || 300, MAX);
  return list.slice(-limit).reverse();
}

/** Lifetime counts per level. Never decremented as entries age out. */
function counts() {
  return { ...lifetime };
}

/** Counts over the buffered window — what the log page is actually showing. */
function bufferedCounts() {
  const out = { info: 0, warn: 0, error: 0 };
  for (const e of entries) out[e.level] += 1;
  return out;
}

function clear() {
  entries.length = 0;
}

module.exports = { push, recent, counts, bufferedCounts, clear, LEVELS, sanitiseMeta, classifyNavError };
