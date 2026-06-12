// Form-based login to Court Reserve (username + password, not the Google button).
// Returns a logged-in Playwright context whose cookies authenticate the JSON APIs.

import { ORG_ID } from './constants.js';

const LOGIN_URL = (portalUrl) =>
  portalUrl || `https://app.courtreserve.com/Online/Account/Login/${ORG_ID}`;

export async function login(browser, cfg) {
  const ctx = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    locale: 'en-CA',
    timezoneId: 'America/Toronto',
  });
  const page = await ctx.newPage();

  await page.goto(LOGIN_URL(cfg.portalUrl), { waitUntil: 'domcontentloaded' });

  // Fill the native login form. Court Reserve uses UserNameOrEmail/Password, but
  // fall back to generic email/password inputs so a markup tweak won't break us.
  const user = page.locator(
    'input[name="UserNameOrEmail"], input#UserNameOrEmail, input[type="email"]'
  ).first();
  const pass = page.locator(
    'input[name="Password"], input#Password, input[type="password"]'
  ).first();

  await user.waitFor({ state: 'visible', timeout: 15000 });
  await user.fill(cfg.username);
  await pass.fill(cfg.password);

  // Submit and wait for navigation away from the login page.
  await Promise.all([
    page.waitForLoadState('networkidle').catch(() => {}),
    page.locator(
      'button[type="submit"], input[type="submit"], button:has-text("Sign In"), button:has-text("Log In")'
    ).first().click(),
  ]);

  // Verify we actually landed in the portal (and not back on the login page).
  await page.waitForURL(/\/Online\/(Portal|Reservations|Member)/i, { timeout: 20000 })
    .catch(() => {});
  const url = page.url();
  if (/\/Account\/Login/i.test(url)) {
    const err = await page.locator('.validation-summary-errors, .field-validation-error')
      .first().textContent().catch(() => null);
    throw new Error(`Login failed (still on login page). ${err ? 'Portal said: ' + err.trim() : ''}`);
  }

  return { ctx, page };
}
