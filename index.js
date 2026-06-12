// Entry point. Arms early, sleeps to exactly 7:00:00 club-local, then books.
//
// The runner (GitHub Actions) only needs to be ALIVE before 7:00 — the precise
// firing is done here in code, which neutralizes Actions' cron drift.

import { loadConfig } from './config.js';
import { msUntilOpen, targetBookingDate, withinBookingWindow, clubToday } from './time.js';
import { runBooking } from './book.js';
import { notify } from './notify.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

async function main() {
  const cfg = loadConfig();
  if (cfg.targetDate && !/^\d{4}-\d{2}-\d{2}$/.test(cfg.targetDate)) {
    throw new Error(`CR_TARGET_DATE must be YYYY-MM-DD, got: ${cfg.targetDate}`);
  }
  const targetDate = cfg.targetDate || targetBookingDate();

  console.log(`[tennis-agent] club-today=${clubToday()} target=${targetDate}` +
    `${cfg.targetDate ? ' (override)' : ''} hour=${cfg.targetHour} dryRun=${cfg.dryRun} discover=${cfg.discover}`);

  // Testing / discovery: run immediately, skip the 7 AM arming.
  if (cfg.runNow) {
    const r = await runBooking(cfg, targetDate);
    console.log('[tennis-agent] result:', JSON.stringify(r));
    await notify(cfg, r);
    if (!r.ok) process.exitCode = 1;
    return;
  }

  // If a runner boots way too late (outside the window entirely), bail cleanly
  // so a queued standby — or tomorrow's run — can handle it.
  let waitMs = msUntilOpen();
  if (waitMs > 20 * 60_000) {
    console.log(`[tennis-agent] ${Math.round(waitMs / 1000)}s early — outside arming window, exiting.`);
    return;
  }

  // Arm: open the browser + log in NOW so we're ready, then sleep to the second.
  // (book.js#prepare establishes the warm session; runBooking fires at open.)
  if (waitMs > 0) {
    console.log(`[tennis-agent] armed; sleeping ${(waitMs / 1000).toFixed(1)}s until open…`);
    await sleep(waitMs);
  } else {
    console.log(`[tennis-agent] already past open by ${-Math.round(waitMs / 1000)}s — firing now.`);
  }

  if (!withinBookingWindow()) {
    console.log('[tennis-agent] outside booking window after wait — exiting.');
    return;
  }

  const result = await runBooking(cfg, targetDate);
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
