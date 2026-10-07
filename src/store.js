'use strict';

const config = require('./config');
const { EXCHANGES } = require('./exchanges');

/**
 * In-memory ring buffer of checks, kept per exchange, plus the derived
 * statistics a regulator cares about: compliance rate, violation count and
 * when the last violation happened.
 */
class ExchangeStore {
  constructor(id) {
    this.id = id;
    this.history = [];
    this.totalChecks = 0;
    this.compliantChecks = 0;
    this.violationChecks = 0;
    this.unknownChecks = 0;
    this.consecutiveCompliant = 0;
    this.consecutiveViolations = 0;
    this.currentState = null;
    this.currentStateSince = null;
    this.lastViolationAt = null;
    this.lastViolationPrice = null;
    this.durations = [];
  }

  add(report) {
    this.history.push({
      checkedAt: report.checkedAt,
      exchangeId: report.exchangeId,
      state: report.state,
      priceVisible: report.priceVisible,
      price: report.price ? report.price.value : null,
      flash: !!(report.flashNote),
      durationMs: report.durationMs,
    });
    if (this.history.length > config.historyLimit) {
      this.history.splice(0, this.history.length - config.historyLimit);
    }

    this.totalChecks += 1;
    this.durations.push(report.durationMs);
    if (this.durations.length > 100) this.durations.shift();

    if (report.state === 'compliant') this.compliantChecks += 1;
    else if (report.state === 'violation') this.violationChecks += 1;
    else this.unknownChecks += 1;

    this.consecutiveCompliant = report.state === 'compliant' ? this.consecutiveCompliant + 1 : 0;
    this.consecutiveViolations = report.state === 'violation' ? this.consecutiveViolations + 1 : 0;

    if (this.currentState !== report.state) {
      this.currentState = report.state;
      this.currentStateSince = report.checkedAt;
    }

    if (report.state === 'violation') {
      this.lastViolationAt = report.checkedAt;
      this.lastViolationPrice = report.price ? report.price.value : null;
    }
  }

  stats() {
    const decided = this.compliantChecks + this.violationChecks;
    return {
      exchangeId: this.id,
      totalChecks: this.totalChecks,
      compliantChecks: this.compliantChecks,
      violationChecks: this.violationChecks,
      unknownChecks: this.unknownChecks,
      // "unknown" is never counted as a pass.
      compliancePercent: decided ? (this.compliantChecks / decided) * 100 : null,
      decidedChecks: decided,
      consecutiveCompliant: this.consecutiveCompliant,
      consecutiveViolations: this.consecutiveViolations,
      currentState: this.currentState,
      currentStateSince: this.currentStateSince,
      lastViolationAt: this.lastViolationAt,
      lastViolationPrice: this.lastViolationPrice,
      avgDurationMs: this.durations.length
        ? this.durations.reduce((a, b) => a + b, 0) / this.durations.length
        : null,
    };
  }

  recent(limit = 30) {
    return this.history.slice(-limit).reverse();
  }

  contextSince() {
    return this.currentStateSince;
  }
}

class Store {
  constructor() {
    this.startedAt = new Date().toISOString();
    this.reports = new Map(); // latest report per exchange
    this.stores = new Map(EXCHANGES.map((e) => [e.id, new ExchangeStore(e.id)]));
  }

  add(report) {
    this.reports.set(report.exchangeId, report);
    const s = this.stores.get(report.exchangeId);
    if (s) s.add(report);
  }

  report(id) {
    return this.reports.get(id) || null;
  }

  store(id) {
    return this.stores.get(id);
  }

  /** Combined view across every exchange, worst state first. */
  overall() {
    const stats = [...this.stores.values()].map((s) => s.stats());
    const totalViolations = stats.reduce((a, s) => a + s.violationChecks, 0);
    const lastViolationAt = stats
      .map((s) => s.lastViolationAt)
      .filter(Boolean)
      .sort()
      .pop() || null;

    let state = 'compliant';
    if (stats.some((s) => s.currentState === 'violation')) state = 'violation';
    else if (stats.some((s) => s.currentState === 'unknown')) state = 'unknown';

    // The headline rate counts EXCHANGES, not checks. «نرخ رعایت دستور» reads to
    // a human as "of the exchanges under surveillance, how many are obeying the
    // order" — a per-exchange question. Summing lifetime check counters instead
    // answers a different question ("of all the checks ever run, how many
    // passed") and drifts upward forever: after a few cycles a watchlist with
    // 8 breaching exchanges reported 39 violations against 20 exchanges.
    //
    // Each exchange contributes its CURRENT state (the latest report), which is
    // already what `state` above is derived from, so the headline rate and the
    // per-exchange cards can never disagree.
    //
    // An exchange whose latest state is `unknown` — or that has never been
    // checked — is undecided, not compliant, so it is excluded from the
    // denominator. That matches the documented rule that نامشخص عمداً رعایت
    // حساب نمی‌شود.
    const decidedEx = stats.filter(
      (s) => s.currentState === 'compliant' || s.currentState === 'violation'
    );
    const compliantEx = decidedEx.filter((s) => s.currentState === 'compliant');

    const decided = stats.reduce((a, s) => a + s.decidedChecks, 0);

    return {
      startedAt: this.startedAt,
      state,
      totalChecks: stats.reduce((a, s) => a + s.totalChecks, 0),
      totalViolations,
      // Kept for compatibility: the lifetime check-based ratio, as before.
      // `compliancePercent` below is the headline figure the UI shows.
      checkCompliancePercent: decided
        ? (stats.reduce((a, s) => a + s.compliantChecks, 0) / decided) * 100
        : null,
      decidedChecks: decided,
      compliancePercent: decidedEx.length
        ? (compliantEx.length / decidedEx.length) * 100
        : null,
      compliantExchanges: compliantEx.length,
      decidedExchanges: decidedEx.length,
      unknownExchanges: stats.filter((s) => s.currentState === 'unknown').length,
      lastViolationAt,
      exchangeCount: stats.length,
    };
  }

  /** Interleaved history across exchanges, newest first. */
  recent(limit = 40) {
    const all = [];
    for (const s of this.stores.values()) all.push(...s.history);
    return all.sort((a, b) => (a.checkedAt < b.checkedAt ? 1 : -1)).slice(0, limit);
  }
}

module.exports = new Store();