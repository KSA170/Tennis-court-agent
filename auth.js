// Form-based login to Court Reserve (username + password, not the Google button).
// Returns a logged-in Playwright context whose cookies authenticate the JSON APIs.

import { promises as fs } from 'fs';
import { ORG_ID } from './constants.js';

const LOGIN_URL = (portalUrl) =>
  portalUrl || `https://app.courtreserve.com/Online/Account/Login/${ORG_ID}`;

/** Dump page state to the log (pasteable) and to debug/ (artifact) for diagnosis. */
async function diagnose(page, name) {
  let url = '', title = '', controls = [];
  try { url = page.url(); } catch {}
  try { title = await page.title(); } catch {}
  try {
    controls = await page.$$eval('input, button, a.btn, [type="submit"]', (els) =>
      els.slice(0, 40).map((e) => ({
        tag: e.tagName, type: e.getAttribute('type') || '', name: e.getAttribute('name') || '',
        id: e.id || '', placeholder: e.getAttribute('placeholder') || '',
        text: (e.innerText || e.value || '').trim().slice(0, 30),
      }))
    );
  } catch {}
  console.log(`\n===== LOGIN PAGE DIAGNOSTIC (${name}) =====`);
  console.log('url  :', url);
  console.log('title:', title);
  console.log('controls:', JSON.stringify(controls));
  console.log('=========================================\n');
  try {
    await fs.mkdir('debug', { recursive: true });
    await page.screenshot({ path: `debug/${name}.png`, fullPage: true }).catch(() => {});
    await fs.writeFile(`debug/${name}.html`, await page.content().catch(() => ''));
  } catch {}
}

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
  await page.waitForLoadState('networkidle').catch(() => {});

  // A Cloudflare interstitial would hide the form; give it a moment to clear.
  if (/just a moment|attention required|checking your browser/i.test(await page.title().catch(() => ''))) {
    console.log('[auth] Cloudflare challenge detected — waiting for it to clear…');
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(4000);
  }

  const user = page.locator(
    'input[name="UserNameOrEmail"], input#UserNameOrEmail, input[name="Username"], ' +
    'input[name="Email"], input[type="email"], input[autocomplete="username"]'
  ).first();
  const pass = page.locator(
    'input[name="Password"], input#Password, input[type="password"], input[autocomplete="current-password"]'
  ).first();

  try {
    await user.waitFor({ state: 'visible', timeout: 30000 });
  } catch (e) {
    await diagnose(page, 'login-no-field');
    throw new Error('Could not find the username field on the login page — see the ' +
      'LOGIN PAGE DIAGNOSTIC above (and the debug artifact) for the real selectors.');
  }

  await user.fill(cfg.username);
  await pass.fill(cfg.password);

  await Promise.all([
    page.waitForLoadState('networkidle').catch(() => {}),
    page.locator(
      'button[type="submit"], input[type="submit"], button:has-text("Sign In"), ' +
      'button:has-text("Log In"), button:has-text("Login")'
    ).first().click(),
  ]);

  await page.waitForURL(/\/Online\/(Portal|Reservations|Member)/i, { timeout: 20000 }).catch(() => {});
  const url = page.url();
  if (/\/Account\/Login/i.test(url)) {
    await diagnose(page, 'login-rejected');
    const err = await page.locator('.validation-summary-errors, .field-validation-error')
      .first().textContent().catch(() => null);
    throw new Error(`Login failed (still on login page). ${err ? 'Portal said: ' + err.trim() : 'Check credentials / see diagnostic above.'}`);
  }

  console.log('[auth] logged in — at', url);
  return { ctx, page };
}
