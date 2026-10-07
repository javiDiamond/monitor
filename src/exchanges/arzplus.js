'use strict';

/**
 * ارزپلاس (arzplus.net) — adapter.
 *
 * Monitored page: https://panel.arzplus.net/price/tether
 *
 * The second tenant of the shared white-label platform; the probe and the
 * market-feed parser live in ./whiteLabel.js. Only identity and endpoints are
 * declared here.
 *
 * Like راستین, ارزپلاس shows the price nowhere at rest — the toman figure only
 * appears in the buy converter once a value is typed into the tether field.
 * Worth noting for interpretation: this page never live-updates its figures
 * (no websocket, no polling) and even prints its own "آخرین به‌روزرسانی"
 * stamp, so the figure captured here can be stale even when it is a genuine
 * disclosure.
 */
const { createAdapter } = require('./whiteLabel');

module.exports = createAdapter({
  id: 'arzplus',
  name: 'ارزپلاس',
  host: 'panel.arzplus.net',
  url: 'https://panel.arzplus.net/price/tether',
  apiUrl: 'https://api.arzplus.net/api/v1/asset/overview/',
});
