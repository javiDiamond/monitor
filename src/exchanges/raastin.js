'use strict';

/**
 * راستین (raastin.com) — adapter.
 *
 * Monitored page: https://raastin.com/price/tether
 *
 * One of two tenants of the shared white-label platform; the probe and the
 * market-feed parser live in ./whiteLabel.js. Only identity and endpoints are
 * declared here.
 *
 * راستین shows the tether price NOWHERE at rest. The only toman figure the
 * page produces is the buy converter's output once a user types into the
 * tether field — the shared probe performs that exact interaction and judges
 * the result like any other display surface.
 */
const { createAdapter } = require('./whiteLabel');

module.exports = createAdapter({
  id: 'raastin',
  name: 'راستین',
  host: 'raastin.com',
  url: 'https://raastin.com/price/tether',
  apiUrl: 'https://api.raastin.com/api/v1/asset/overview/',
});
