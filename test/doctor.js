'use strict';

/**
 * Doctor: can this host actually run the browser the monitor depends on?
 *
 * Two installs are needed and only one of them is obvious. `npx playwright install
 * chromium` downloads the browser binary; it does not touch the operating system.
 * A host with the binary but without the shared libraries reports
 *
 *   browserType.launch: Host system is missing dependencies to run browsers
 *
 * for every exchange, forever, and the dashboard just shows a column of «نامشخص».
 * This script turns that into one command's answer.
 *
 * It deliberately drives src/scraper.js — the same launch path, including the
 * msedge -> bundled-chromium fallback — rather than opening Playwright itself. A
 * parallel check could pass while the monitor still failed.
 *
 * Exit code 0 = the browser launches. 1 = it does not, and the reason is printed.
 */

const { chromium } = require('playwright');
const config = require('../src/config');
const { preflightBrowser } = require('../src/scraper');

function line(label, value) {
  console.log(`  ${label}: ${value}`);
}

(async () => {
  console.log('\n=== بررسی سلامت مرورگر ===\n');

  console.log('مشخصات محیط:');
  line('Node', process.version);
  line('Playwright', require('playwright/package.json').version);
  line('کانال درخواستی', config.browserChannel);
  line('حالت اجرا', config.headless ? 'headless' : 'headful (HEADLESS=false)');

  // Where Playwright would look for a browser. Purely informational: on this host
  // the executable existing does not mean it can start, which is the whole point.
  try {
    line('مسیر مرورگر', chromium.executablePath());
  } catch {
    line('مسیر مرورگر', 'پیدا نشد — `npx playwright install chromium` را اجرا کنید');
  }

  console.log('\nاجرای آزمایشی مرورگر:');

  let health;
  try {
    // preflightBrowser opens a browser and closes it again, and never throws.
    health = await preflightBrowser();
  } finally {
    // Belt and braces: if preflightBrowser ever regressed into leaving a browser
    // behind, this script must not be the thing that keeps one alive.
    try {
      require('../src/scraper').closeBrowser();
    } catch {
      /* nothing was open */
    }
  }

  if (health.ok) {
    console.log(`\n  ✓ مرورگر آماده است: ${health.channel} ${health.version}`);
    console.log('\n  وضعیت پایش: عادی\n');
    process.exit(0);
  }

  console.log(`\n  ✗ مرورگر اجرا نشد: ${health.message}`);
  console.log(`\n  راه‌حل: ${health.hint}`);
  if (health.code === 'browser_launch_failed') {
    // `hint` is deliberately reduced to one line, because the monitor also serves
    // it on an unauthenticated endpoint. Playwright's own full stderr — executable
    // path, user-data-dir, browser logs — is still available here locally.
    console.log(`\n  جزئیات فنی: ${health.hint}`);
    console.log('  برای دیدن خطای کامل Playwright:');
    console.log('    DEBUG=pw:browser npm run doctor');
  }
  console.log('\n  تا وقتی این مشکل حل نشود، هیچ صرافی مرورگرمحوری بررسی نمی‌شود.\n');
  process.exit(1);
})().catch((err) => {
  console.error('\n  ✗ خود ابزار بررسی با خطا متوقف شد:', err.message);
  process.exit(1);
});
