'use strict';

const { toLatinDigits, toPersianDigits, formatMoney, formatPercent } = require('./persian');

/**
 * The platforms under watch have been instructed to stop displaying this price.
 *
 * So a hidden price is the CORRECT, expected outcome, and a price that is still
 * on screen is a VIOLATION. This module turns a raw page read into that verdict.
 */

/* ------------------------------------------------------------------ *
 * Reading a value out of the page
 * ------------------------------------------------------------------ */

/**
 * Decide whether a raw string is a real price. A dash, "---", a zero, an empty
 * cell or unreadable text all mean "no price shown".
 */
function classifyValue(raw) {
  if (raw === null || raw === undefined) {
    return { ok: false, code: 'absent', value: null, raw: '' };
  }
  const text = String(raw).replace(/\s+/g, ' ').trim();
  if (text === '') return { ok: false, code: 'empty', value: null, raw: text };
  if (/^[-–—_.،,٫\s]+$/.test(text)) {
    return { ok: false, code: 'placeholder', value: null, raw: text };
  }
  if (/^-{2,}$/.test(text)) {
    return { ok: false, code: 'placeholder', value: null, raw: text };
  }

  const latin = toLatinDigits(text).trim();
  if (/^[-−]/.test(latin)) return { ok: false, code: 'negative', value: null, raw: text };

  const digits = latin.replace(/[,\s٬]/g, '');
  const numeric = digits.replace(/[^\d.]/g, '');
  if (numeric === '') return { ok: false, code: 'unparseable', value: null, raw: text };

  const value = Number(numeric);
  if (!Number.isFinite(value)) return { ok: false, code: 'unparseable', value: null, raw: text };
  if (value < 0) return { ok: false, code: 'negative', value: null, raw: text };
  if (value === 0) return { ok: false, code: 'zero', value: null, raw: text };
  return { ok: true, code: 'ok', value, raw: text };
}

/* ------------------------------------------------------------------ *
 * Labels
 * ------------------------------------------------------------------ */

const REASON_LABEL = {
  placeholder: 'نمایش خط تیره به‌جای عدد',
  zero: 'نمایش صفر به‌جای قیمت',
  empty: 'قیمت خالی است',
  unparseable: 'مقدار نامعتبر',
  negative: 'مقدار منفی',
  absent: 'محل قیمت پیدا نشد',
  unreachable: 'سایت در دسترس نبود',
  feed_stalled: 'صفحه کامل بارگذاری نشد',
  http_error: 'سرور پاسخ نامعتبر داد',
  visibility_error: 'بررسی قابلیت دیدن ناموفق بود',
  browser_unavailable: 'مرورگر در دسترس نیست',
  page_disabled: 'صفحهٔ تتر غیرفعال شده است',
  frozen_flash: 'نمایش لحظه‌ای هنگام بارگذاری',
  error: 'خطا در بررسی',
};

const POLICY_LABEL = {
  hidden: 'پنهان بودن قیمت',
  shown: 'نمایش قیمت',
};

/** "۲ دقیقه" — how long the current state has held. */
function durationPhrase(from, now) {
  if (!from) return null;
  const mins = Math.floor((now - new Date(from).getTime()) / 60000);
  if (mins < 1) return 'کمتر از یک دقیقه';
  if (mins < 60) return `${toPersianDigits(mins)} دقیقه`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${toPersianDigits(hours)} ساعت و ${toPersianDigits(mins % 60)} دقیقه`;
  return `${toPersianDigits(Math.floor(hours / 24))} روز`;
}

/**
 * The leading numeric token of a page title, if it reads as a real price.
 *
 * رمزینکس publishes the tether price in the browser tab's own title
 * (`2,678,500 IRR | رمزینکس تریدر | تتر`), which no element probe can see. That
 * is a real finding and it is reported here — but see the comment at the
 * `visibleEntry` computation: it must never be able to decide a verdict.
 *
 * Only the FIRST numeric token is considered, so a title like
 * `USDT/IRT - 24h volume 12,000` cannot be read as a price by accident.
 */
function titlePrice(scrape, unitLabel) {
  const raw = scrape && scrape.pageTitle;
  if (!raw) return null;
  const text = String(raw);
  const m = text.match(/[\d۰-۹٠-٩][\d۰-۹٠-٩.,٬٫\s٫]*/);
  if (!m) return null;
  const parsed = classifyValue(m[0]);
  if (!parsed.ok) return null;
  return {
    value: parsed.value,
    formatted: formatMoney(parsed.value),
    source: 'عنوان صفحه',
    unit: unitLabel || 'ریال',
    raw: text,
  };
}

/** The Persian sentence describing a title that carries a price. */
function titlePriceNote(tp, unitLabel) {
  if (!tp) return null;
  return `توجه: قیمت تتر در عنوان صفحه (سربرگ مرورگر) هم نمایش داده می‌شود: ${tp.formatted} ${unitLabel}.`;
}

/** The note about a price that was visible while the page was still rendering. */
function flashNote(flashed) {
  if (!flashed || !flashed.detected) return null;
  const secs = Math.max(1, Math.round((flashed.durationMs || 0) / 1000));
  const parsed = classifyValue(flashed.price);
  const value = parsed.ok ? ` (${formatMoney(parsed.value)} تومان)` : '';
  return `قیمت تتر در ابتدای بارگذاری صفحه${value} حدود ${toPersianDigits(secs)} ثانیه نمایش داده شد و پس از کامل شدن بارگذاری حذف شد.`;
}

/* ------------------------------------------------------------------ *
 * Observation -> judgement
 * ------------------------------------------------------------------ */

/**
 * @param {object} scrape  result of scrapeExchange() for one exchange
 * @param {object} api     cross-check from that exchange's public feed
 * @param {string} expect  policy: 'hidden' | 'shown'
 * @param {object} context { since } — when the current state began
 * @param {string} unitLabel  currency the page itself quotes in ('تومان' / 'ریال')
 */
function buildReport({ scrape, api, expect = 'hidden', context = {}, unitLabel = 'تومان' }) {
  const at = new Date().toISOString();
  const now = Date.parse(at);
  const policy = { expect, label: POLICY_LABEL[expect] || expect };
  // The browser tab's title, when the exchange puts the price there. Described,
  // never judged — see the comment at `visibleEntry`.
  const tp = titlePrice(scrape, unitLabel);
  const base = {
    checkedAt: at,
    policy,
    exchangeId: scrape ? scrape.exchangeId : null,
    priceVisible: false,
    state: 'unknown',
    durationMs: (scrape && scrape.durationMs) || 0,
    flashNote: flashNote(scrape && scrape.flashed),
    httpStatus: (scrape && scrape.httpStatus) || null,
    titlePrice: tp,
    // When the primary page would not load and a backup surface answered
    // instead, the verdict is real but the operator must know WHICH surface
    // produced it. A regulator must never read «رعایت شده» without knowing
    // that came from the trading app, not the public price page.
    usedFallback: (scrape && scrape.usedFallback) || null,
  };

  /* ---- the browser itself would not start ---- */

  // Ahead of the navError branch below, which would otherwise report this as
  // «صفحه باز نشد» — a claim about the exchange when the real fault is on this
  // host, and one that every browser-backed exchange would make at once.
  if (scrape && scrape.browserError) {
    return {
      ...base,
      reasonCode: 'browser_unavailable',
      reasonLabel: REASON_LABEL.browser_unavailable,
      title: 'وضعیت نامشخص',
      description: `مرورگر اجرا نشد و این صرافی بررسی نشد: ${scrape.browserError.message}`,
      // The remedy is a shell command, not a finding about the exchange, so it
      // belongs in the detail slot the detail page renders on its own line.
      detail: scrape.browserError.hint,
    };
  }

  /* ---- could not read the page ---- */
  if (!scrape || scrape.navError) {
    return {
      ...base,
      reasonCode: 'unreachable',
      reasonLabel: REASON_LABEL.unreachable,
      title: 'وضعیت نامشخص',
      description: 'صفحه باز نشد.',
      detail: (scrape && scrape.navError) || 'خطای نامشخص',
      price: null,
      probes: {},
      api,
    };
  }

  /* ---- the tether page is switched off outright ----
     اتراکس has disabled its USDT page instead of blanking the price on it. A 5xx
     from an adapter that declares `http5xxMeansDisabled` is therefore the
     compliant finding itself — there is no page on which a price could appear —
     and must not read as «نامشخص», which would look like a fault on this host.
     The scraper stamps `pageDisabled` and skips the fallback for it. */
  if (scrape && scrape.pageDisabled) {
    return {
      ...base,
      state: 'compliant',
      reasonCode: 'page_disabled',
      reasonLabel: REASON_LABEL.page_disabled,
      title: 'دستور حذف قیمت تتر رعایت شده است',
      badge: 'رعایت شده',
      description: `صفحهٔ تتر این صرافی غیرفعال شده است و با وضعیت ${toPersianDigits(
        scrape.httpStatus
      )} پاسخ می‌دهد؛ صفحه‌ای که بارگذاری نمی‌شود قیمتی هم برای نمایش ندارد.`,
      price: null,
      probes: scrape.probes || {},
      api,
    };
  }

  /* ---- the server answered, but not with a usable page ----
     A 5xx is a different finding from «بخش قیمت در صفحه ظاهر نشد»: it means the
     exchange's server — or a gate in front of it — refused the request, which
     for a regulator is a fact about the site rather than about rendering.
     اتراکس served 503 on its tether route while every sibling route was fine;
     without this branch that read as a page that merely failed to render. */
  if (scrape.httpStatus && scrape.httpStatus >= 400) {
    return {
      ...base,
      reasonCode: 'http_error',
      reasonLabel: REASON_LABEL.http_error,
      title: 'وضعیت نامشخص',
      description: `سرور صفحه را با وضعیت ${toPersianDigits(scrape.httpStatus)} برگرداند.`,
      price: null,
      probes: scrape.probes || {},
      api,
    };
  }

  /* ---- the page loaded, but we could not verify what a user would see ----
     FAIL CLOSED. The scraper discards any sample whose visibility check could
     not be completed, so if none of them verified there is no reliable
     evidence at all — and an unverifiable page must be «نامشخص», never a
     decision either way. */
  if (scrape.visibilityError) {
    return {
      ...base,
      reasonCode: 'visibility_error',
      reasonLabel: REASON_LABEL.visibility_error,
      title: 'وضعیت نامشخص',
      description: 'بررسی قابلیت دیدن قیمت ناموفق بود؛ نتیجهٔ این بررسی قابل اتکا نیست.',
      detail: scrape.visibilityError,
      price: null,
      probes: scrape.probes || {},
      api,
    };
  }

  if (!scrape.ready) {
    return {
      ...base,
      reasonCode: 'feed_stalled',
      reasonLabel: REASON_LABEL.feed_stalled,
      title: 'وضعیت نامشخص',
      // Which surfaces were looked for, and what each one read. This is the
      // line that separates "the price is genuinely withheld" (a surface reads
      // «-» or «خالی») from "the page never rendered" (nothing rendered at
      // all) — two findings that used to print the same sentence and left the
      // whole investigation to guesswork. The per-surface readings are carried
      // in `probes`, which the detail page renders as rows — a separate
      // `detail` string here would only duplicate them.
      description: ['بخش قیمت در صفحه ظاهر نشد.', titlePriceNote(tp, unitLabel)]
        .filter(Boolean)
        .join(' '),
      price: null,
      probes: scrape.probes,
      api,
    };
  }

  const probes = scrape.probes || {};
  const entries = Object.entries(probes).map(([key, p]) => ({ key, ...p, ...classifyValue(p.raw) }));
  // Only a price a user can SEE counts. Probes carry `visible` from the
  // scraper; absent means "unknown", which we treat as visible so older data
  // (and unit tests) keep working.
  //
  // **`titlePrice` MUST NEVER BE CONSULTED HERE, OR ANYWHERE ABOVE THIS LINE.**
  // It is the browser tab's own title, which some exchanges fill with the price.
  // Reading it into `visibleEntry` would let a string flip a compliant exchange
  // to «تخلف» on the strength of something no user can see on the page — and a
  // page screenshot can never evidence it either. It is a separate finding,
  // described in the sentence below and never judged.
  const visibleEntry = entries.find((e) => e.ok && e.visible !== false);
  const hiddenPriceEntry = entries.find((e) => e.ok && e.visible === false);
  const primaryEntry = entries.find((e) => e.primary) || entries[0];
  const visible = !!visibleEntry;
  const compliant = expect === 'hidden' ? !visible : visible;

  /* ---- the page froze mid-check while the price was still on screen ----
     wallex.ir locks its main thread mid-check (measured anywhere between
     ~0.4s and ~8s after load). When sampling ends that way, the withdrawal
     this page performs right after load could not be observed — and per the
     operator's standing decision this page reads as the documented LOAD FLASH
     (the nobitex pattern): the price shows for a moment and is withdrawn, so
     the verdict is compliance with a flash note, never a violation built from
     a reading the page itself was about to withdraw. An OBSERVED withdrawal
     (blank last reading) takes the normal compliant path below. */
  if (scrape.frozenEnded && visible) {
    const p = visibleEntry;
    const hiddenIsExpected = expect === 'hidden';
    return {
      ...base,
      state: hiddenIsExpected ? 'compliant' : 'unknown',
      reasonCode: 'frozen_flash',
      reasonLabel: REASON_LABEL.frozen_flash,
      title: hiddenIsExpected ? 'دستور حذف قیمت تتر رعایت شده است' : 'وضعیت نامشخص',
      badge: hiddenIsExpected ? 'رعایت شده' : undefined,
      description: [
        'قیمت تتر پس از بارگذاری صفحه نمایش داده نمی‌شود.',
        `در ابتدای بارگذاری، قیمت با مقدار ${formatMoney(p.value)} ${unitLabel} دیده شد و بلافاصله حذف شد (نمایش لحظه‌ای).`,
        'بررسیِ پایداری ممکن نشد چون صفحه در میانهٔ کار از پاسخ‌دادن بازایستاد.',
      ].join(' '),
      flashNote: `قیمت تتر در ابتدای بارگذاری صفحه (${formatMoney(p.value)} ${unitLabel}) نمایش داده شد؛ صفحه پیش از تکمیل بررسی از پاسخ‌دادن بازایستاد. بر اساس الگوی تکرارشدهٔ این صفحه، این نمایش لحظه‌ای است و بلافاصله حذف می‌شود.`,
      price: null,
      priceVisible: false,
      probes,
      api,
    };
  }

  /* ---- the page never finished rendering ---- */
  if (!scrape.feedLive && !visible) {
    return {
      ...base,
      reasonCode: 'feed_stalled',
      reasonLabel: REASON_LABEL.feed_stalled,
      title: 'وضعیت نامشخص',
      description: ['صفحه کامل بارگذاری نشد.', titlePriceNote(tp, unitLabel)].filter(Boolean).join(' '),
      price: null,
      probes,
      api,
    };
  }

  /* ---- price is on screen ---- */
  if (visible) {
    const p = visibleEntry;
    const parts = [
      `قیمت تتر با مقدار ${formatMoney(p.value)} ${unitLabel} در صفحه نمایش داده می‌شود.`,
      `محل نمایش: ${p.label}.`,
    ];
    if (context.since) parts.push(`مدت این وضعیت: ${durationPhrase(context.since, now)}.`);
    if (base.usedFallback) {
      parts.push(`صفحهٔ اصلی در دسترس نبود؛ این نتیجه از «${base.usedFallback.label}» خوانده شد.`);
    }
    // A separate finding, appended last so it reads as an aside. It does not
    // participate in `state`, `priceVisible` or `price` above.
    if (tp) parts.push(titlePriceNote(tp, unitLabel));

    return {
      ...base,
      priceVisible: true,
      state: compliant ? 'compliant' : 'violation',
      reasonCode: 'shown',
      reasonLabel: 'قیمت روی صفحه است',
      title:
        expect === 'hidden' ? 'تخلف: قیمت تتر نمایش داده می‌شود' : 'قیمت تتر نمایش داده می‌شود',
      badge: expect === 'hidden' ? 'تخلف' : 'مطابق انتظار',
      description: parts.join(' '),
      price: { value: p.value, formatted: formatMoney(p.value), source: p.label, unit: unitLabel },
      change: null,
      probes,
      api,
    };
  }

  /* ---- price is not on screen ---- */
  // Report the most specific "no price" reason we found.
  // Report why the PRIMARY (most prominent) display shows no price; fall back to
  // any other usable probe when the primary was simply missing.
  let reason = primaryEntry;
  if (!reason || reason.code === 'absent' || reason.code === 'empty') {
    reason = entries.find((e) => e.code !== 'absent' && e.code !== 'empty') || primaryEntry;
  }

  const parts = ['قیمت تتر در صفحه نمایش داده نمی‌شود.'];
  if (base.usedFallback) {
    parts.push(`صفحهٔ اصلی در دسترس نبود؛ این نتیجه از «${base.usedFallback.label}» خوانده شد.`);
  }
  // When the primary still parses as a real price, the "sign" is not an error
  // at all — it is a price that is present but hidden, which the specific note
  // below explains far better than a generic reason label would.
  if (reason.code !== 'ok') {
    // A slot that exists but says nothing is different from a missing one.
    if (reason.emptyText) {
      parts.push(`وضعیت این بخش: «${reason.emptyText}»`);
    } else {
      parts.push(`نشانه: ${REASON_LABEL[reason.code] || REASON_LABEL.unparseable}.`);
    }
  }
  // A price can sit in the DOM off-screen, clipped away, or deliberately
  // blurred. None of those is a breach, but each deserves to be said plainly
  // rather than passing silently.
  if (hiddenPriceEntry) {
    const where = `«${hiddenPriceEntry.label}» مقدار ${formatMoney(hiddenPriceEntry.value)}`;
    const reason = hiddenPriceEntry.reason;
    if (reason === 'blurred') {
      parts.push(
        `توجه: در ${where} وجود دارد، اما عمداً محو و ناخوانا نمایش داده شده و برای کاربر قابل خواندن نیست.`
      );
    } else if (reason === 'not-rendered' || reason === 'zero-size') {
      parts.push(
        `توجه: در ${where} وجود دارد، اما این بخش در صفحه نمایش داده نمی‌شود (با display:none مخفی شده است).`
      );
    } else {
      parts.push(
        `توجه: در ${where} وجود دارد، اما این بخش برای کاربر قابل مشاهده نیست (خارج از محدوده نمایش یا پشت بخش دیگری).`
      );
    }
  }
  if (api && api.price) parts.push('قیمت همچنان در API عمومی صرافی در دسترس است.');
  if (context.since) parts.push(`مدت این وضعیت: ${durationPhrase(context.since, now)}.`);
  // Last, and for the same reason: a title that carries a price is reported,
  // never judged.
  if (tp) parts.push(titlePriceNote(tp, unitLabel));

  return {
    ...base,
    priceVisible: false,
    state: compliant ? 'compliant' : 'violation',
    reasonCode: 'hidden',
    reasonLabel: REASON_LABEL[reason.code] || REASON_LABEL.unparseable,
    title:
      expect === 'hidden'
        ? 'دستور حذف قیمت تتر رعایت شده است'
        : 'تخلف: قیمت تتر نمایش داده نمی‌شود',
    badge: expect === 'hidden' ? 'رعایت شده' : 'تخلف',
    description: parts.join(' '),
    price: null,
    change: null,
    probes,
    api,
  };
}

function parseChange(raw) {
  if (!raw) return null;
  const digits = toLatinDigits(raw).replace(/[^\d.]/g, '');
  const n = Number(digits);
  if (!Number.isFinite(n)) return null;
  return { value: n, formatted: formatPercent(n), raw };
}

module.exports = { buildReport, classifyValue };