// Entry point. Holds the runner alive until just before open, logs in (fresh
// tokens), sleeps to exactly 7:00:00 club-local, then books.
//
// GitHub Actions cron is best-effort and often delayed 30+ min, so a runner may
// not boot until well AFTER open. When that happens we still attempt the booking
// immediately — for a first-come system a late try is strictly better than none,
// and the slot is frequently still free. The in-process sleep neutralizes cron
// drift only when a runner does boot before open.

import { loadConfig } from './config.js';
import { msUntilOpen, targetBookingDate, clubToday, isWeekend } from './time.js';
import { runBooking, prepareBooking, fireBooking, runUpgradeSweep } from './book.js';
import { notify } from './notify.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

// Log in this long before open: enough to absorb login + a Cloudflare challenge,
// while keeping the session/tokens fresh when we fire.
const ARM_LEAD_MS = 90_000;
// If a runner boots earlier than this before open, exit and let a later-scheduled
// cron pick it up closer to open (avoids holding a runner idle for ages).
const MAX_EARLY_MS = 40 * 60_000;

async function main() {
  const cfg = loadConfig();
  if (cfg.targetDate && !/^\d{4}-\d{2}-\d{2}$/.test(cfg.targetDate)) {
    throw new Error(`CR_TARGET_DATE must be YYYY-MM-DD, got: ${cfg.targetDate}`);
  }
  const targetDate = cfg.targetDate || targetBookingDate();

  console.log(`[tennis-agent] club-today=${clubToday()} target=${targetDate}` +
    `${cfg.targetDate ? ' (override)' : ''} hours=[${cfg.targetHours.join(', ')}] ` +
    `mode=${cfg.mode} dryRun=${cfg.dryRun} discover=${cfg.discover}`);

  // Upgrade sweep: independent of the 7 AM open — runs immediately whenever
  // triggered, scans existing bookings, and moves any to a better slot if free.
  if (cfg.mode === 'upgrade') {
    const r = await runUpgradeSweep(cfg);
    console.log('[tennis-agent] upgrade result:', JSON.stringify(r));
    await notify(cfg, r);
    if (!r.ok) process.exitCode = 1;
    return;
  }

  // Weekdays only: the target (today + 6) lands on a weekend ~2 days a week — skip
  // those cleanly. An explicit CR_TARGET_DATE override is always honored.
  if (cfg.weekdaysOnly && !cfg.targetDate && !cfg.discover && isWeekend(targetDate)) {
    console.log(`[tennis-agent] target ${targetDate} is a weekend — nothing to book (weekdays only).`);
    return;
  }

  // Testing / discovery: run immediately, skip the 7 AM arming.
  if (cfg.runNow) {
    const r = await runBooking(cfg, targetDate);
    console.log('[tennis-agent] result:', JSON.stringify(r));
    await notify(cfg, r);
    if (!r.ok) process.exitCode = 1;
    return;
  }

  let waitMs = msUntilOpen();

  // Booted far ahead of open: let a later-scheduled cron handle it nearer the open
  // (one of the staggered crons will land in the arming window or just after).
  if (waitMs > MAX_EARLY_MS) {
    console.log(`[tennis-agent] ${Math.round(waitMs / 1000)}s before open — earlier than the ` +
      `${MAX_EARLY_MS / 60_000}-min arming window; exiting so a later cron picks it up.`);
    return;
  }

  // Hold the runner alive (without logging in yet) until ~ARM_LEAD before open, so
  // the session and tokens are fresh when we fire.
  if (waitMs > ARM_LEAD_MS) {
    const idle = waitMs - ARM_LEAD_MS;
    console.log(`[tennis-agent] ${Math.round(waitMs / 1000)}s before open — idling ` +
      `${Math.round(idle / 1000)}s, then arming ~${ARM_LEAD_MS / 1000}s pre-open…`);
    await sleep(idle);
  }

  // Arm: log in + idempotency check + opponent lookup + session tokens. If the
  // runner only booted AFTER open (cron delay), we arm and attempt anyway.
  const lateBy = -msUntilOpen();
  console.log(lateBy > 0
    ? `[tennis-agent] ${Math.round(lateBy / 1000)}s PAST open (cron delay) — arming and attempting anyway…`
    : '[tennis-agent] arming — logging in and priming the session…');
  const prep = await prepareBooking(cfg, targetDate);
  let result;
  try {
    if (prep.done) {
      result = prep.done;
    } else {
      // Final precise sleep to 7:00:00.000 — only if we're still before open.
      // Never fire early (the slot isn't bookable until open); if already past
      // open, fire immediately.
      waitMs = msUntilOpen();
      if (waitMs > 0) {
        console.log(`[tennis-agent] armed; sleeping ${(waitMs / 1000).toFixed(1)}s to the exact open…`);
        await sleep(waitMs);
      } else {
        console.log(`[tennis-agent] firing now (${Math.round(-waitMs / 1000)}s past open).`);
      }
      result = await fireBooking(prep, cfg, targetDate);
    }
  } finally {
    await prep.browser?.close();
  }
  console.log('[tennis-agent] result:', JSON.stringify(result));
  await notify(cfg, result);

  if (!result.ok) process.exitCode = 1;
}

main().catch(async (err) => {
  console.error('[tennis-agent] fatal:', err);
  try { await notify(loadConfig(), { ok: false, stage: 'fatal', error: String(err?.message ?? err) }); }
  catch { /* notify is best-effort */ }
  process.exitCode = 1;
});
