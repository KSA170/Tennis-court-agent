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

const CF_TITLE = /just a moment|attention required|checking your browser|verifying you are human/i;

/**
 * Navigate to the login page, riding out Cloudflare's managed challenge. The
 * interstitial ("Just a moment…") usually auto-clears in a few seconds, but it
 * can fail to on a fresh runner IP — so we wait for the title to change and
 * re-navigate a couple of times before giving up.
 */
async function gotoLoginPastCloudflare(page, url) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForLoadState('networkidle').catch(() => {});
    if (!CF_TITLE.test(await page.title().catch(() => ''))) return;

    console.log(`[auth] Cloudflare challenge detected (attempt ${attempt}/3) — waiting for it to clear…`);
    // Resolves as soon as the challenge clears; otherwise falls through to retry.
    await page.waitForFunction(
      (re) => !new RegExp(re, 'i').test(document.title),
      CF_TITLE.source, { timeout: 25000 }
    ).catch(() => {});
    if (!CF_TITLE.test(await page.title().catch(() => ''))) return;
    await page.waitForTimeout(3000);
  }
  // Fall through: the field-wait below will diagnose + throw if the form never appears.
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

  await gotoLoginPastCloudflare(page, LOGIN_URL(cfg.portalUrl));

  const user = page.locator(
    'input[name="email"], input[name="Email"], input[name="UserNameOrEmail"], ' +
    'input#UserNameOrEmail, input[name="Username"], input[type="email"], ' +
    'input[autocomplete="username"], input[placeholder*="Email" i]'
  ).first();
  const pass = page.locator(
    'input[name="password"], input[name="Password"], input#Password, ' +
    'input[type="password"], input[autocomplete="current-password"]'
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
      'button[type="submit"], input[type="submit"], button:has-text("Continue"), ' +
      'button:has-text("Sign In"), button:has-text("Log In"), button:has-text("Login")'
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
