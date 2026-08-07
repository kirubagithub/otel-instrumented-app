/**
 * Optional Playwright journey for real browser RUM across SPA routes.
 *
 * Locust is better for volume; Playwright is better for page-level RUM.
 *
 *   npm i -D playwright
 *   npx playwright install chromium
 *   node scripts/playwright-journey.mjs
 */
import { chromium } from 'playwright';

const BASE = process.env.UI_URL || 'http://localhost:5173';

async function run() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  const routes = ['/', '/login', '/catalog', '/checkout', '/orders', '/gates', '/account'];
  for (const route of routes) {
    await page.goto(`${BASE}${route}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(500);
  }

  // Login + buy happy path
  await page.goto(`${BASE}/login`);
  await page.getByRole('button', { name: /random shopper/i }).click();
  await page.waitForTimeout(400);
  await page.goto(`${BASE}/catalog`);
  const buy = page.getByRole('link', { name: /^buy$/i }).first();
  if (await buy.count()) {
    await buy.click();
    await page.getByRole('button', { name: /place order/i }).click();
    await page.waitForURL(/\/orders/, { timeout: 15000 }).catch(() => {});
  }

  await page.waitForTimeout(3000);
  await browser.close();
  console.log('Playwright journey finished — check OpenObserve for service.name=frontend-rum');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
