// Booking orchestration. Drives a logged-in session to grab a 9 PM court the
// instant the window opens, with idempotency and the max-reservation cap handled.

import { chromium } from 'playwright';
import { login } from './auth.js';
import {
  bookCourt, resolveOpponent, getMyBookings, cancelReservation,
  courtsToTry, dumpDiscovery, getSessionTokens,
} from './portal.js';
import { parseHour } from './time.js';
import { membersConfigured } from './constants.js';

/**
 * Phase 1 — everything that can be done BEFORE the window opens: launch, log in,
 * idempotency check, opponent resolution, session tokens. Returns either
 * `{ browser, done }` (terminal result, nothing to fire) or a primed context for
 * fireBooking. Caller owns `browser` and must close it.
 */
export async function prepareBooking(cfg, targetDate) {
  const base = { date: targetDate, hour: cfg.targetHours.join(' > ') };
  if (!cfg.discover && !membersConfigured()) {
    return { done: { ok: false, stage: 'not-configured', ...base,
      reason: 'CR_MEMBERS_JSON secret is missing or has no "self" member — set it (see README).' } };
  }

  const browser = await chromium.launch({ headless: cfg.headless });
  try {
    const { ctx, page } = await login(browser, cfg);

    // Discovery mode: dump the live JSON shapes (availability, my-bookings, member
    // search) so the parsers can be confirmed, then stop.
    if (cfg.discover) {
      await dumpDiscovery(page, ctx, cfg);
      return { browser, done: { ok: true, stage: 'discover', ...base, reason: 'dumped live JSON shapes' } };
    }

    const bookings = await getMyBookings(page);

    // Resolve an opponent (first one that exists in the club directory).
    const opponent = await firstOpponent(ctx, cfg.opponents);
    if (!opponent) {
      return { browser, done: { ok: false, stage: 'no-opponent', ...base,
        reason: `none of [${cfg.opponents.join(', ')}] could be found in the club directory` } };
    }

    // Per-session token the create-reservation form requires.
    const { requestData } = await getSessionTokens(page);

    return { browser, ctx, page, base, bookings, opponent, requestData };
  } catch (err) {
    return { browser, done: { ok: false, stage: 'error', ...base, error: String(err?.message ?? err) } };
  }
}

/**
 * Phase 2 — the time-critical part. Books the BEST available preferred hour
 * (e.g. 9 PM, else 8 PM, else 10 PM) in court-preference order, with the
 * max-reservation cap (cancel a 10 PM, retry) handled.
 */
export async function fireBooking(prep, cfg, targetDate) {
  const { ctx, page, base, opponent, requestData } = prep;
  let { bookings } = prep;
  try {
    const prefs = cfg.targetHours.map((label) => ({ label, hour: parseHour(label) }));
    const cancelHour = parseHour(cfg.cancelHourToFreeSlot); // 22

    // Idempotency. If we already hold the top preference for this date, we're done.
    // If we hold only a lower preference, leave it — upgrading it to a better slot
    // is the job of the separate upgrade sweep, not the initial booking.
    const held = prefs.find((p) => hasSlot(bookings, targetDate, p.hour));
    if (held) {
      return { ok: true, stage: 'already-booked', ...base, hour: held.label,
        reason: held === prefs[0]
          ? `already hold top preference (${held.label})`
          : `already hold ${held.label}; upgrade sweep handles improving it` };
    }

    let cancelled;
    const reasons = [];
    for (const { label, hour } of prefs) {
      let booked = await tryAllCourts(page, ctx, cfg, targetDate, hour, opponent, requestData);

      // Cap is global; free one 10 PM reservation (once) and retry this hour.
      if (booked.blockedByCap && !cancelled) {
        if (!bookings.length) bookings = await getMyBookings(page);
        const victim = pickCancelTarget(bookings, cancelHour);
        if (!victim) {
          return { ok: false, stage: 'cap-blocked', ...base,
            reason: `at the ${cfg.maxReservations}-reservation cap and no ${cfg.cancelHourToFreeSlot} reservation to cancel` };
        }
        const cancelRes = await cancelReservation(page, ctx, victim.id, { dryRun: cfg.dryRun });
        if (!cancelRes.ok) {
          return { ok: false, stage: 'cancel-failed', ...base,
            reason: `could not cancel ${cfg.cancelHourToFreeSlot} reservation ${victim.id}: ${cancelRes.reason}` };
        }
        cancelled = describeBooking(victim);
        booked = await tryAllCourts(page, ctx, cfg, targetDate, hour, opponent, requestData);
      }

      if (booked.ok) {
        return { ok: true, stage: cfg.dryRun ? 'dry-run' : 'booked', ...base, hour: label,
          court: booked.court, opponent: booked.opponent ?? opponent.fullName, cancelled };
      }
      if (booked.blockedByCap) {
        return { ok: false, stage: 'cap-blocked', ...base, cancelled,
          reason: `at the ${cfg.maxReservations}-reservation cap; could not free a slot` };
      }
      reasons.push(`${label}: ${booked.reason}`);
    }
    return { ok: false, stage: 'book-failed', ...base, cancelled,
      reason: `no preferred slot available — ${reasons.join('; ')}` };
  } catch (err) {
    return { ok: false, stage: 'error', ...base, error: String(err?.message ?? err) };
  }
}

/**
 * Prepare + fire in one shot (run-now / discovery / dry-run paths).
 * @returns {Promise<{ok:boolean, stage:string, date:string, hour:string,
 *   court?:string, opponent?:string, cancelled?:string, reason?:string, error?:string}>}
 */
export async function runBooking(cfg, targetDate) {
  const prep = await prepareBooking(cfg, targetDate);
  try {
    if (prep.done) return prep.done;
    return await fireBooking(prep, cfg, targetDate);
  } finally {
    await prep.browser?.close();
  }
}

/** Attempt each court in preference order; first success wins, cap aborts early. */
async function tryAllCourts(page, ctx, cfg, dateStr, hour, opponent, requestData) {
  const reasons = [];
  for (const court of courtsToTry(cfg.courtPreference)) {
    const r = await bookCourt(page, ctx, {
      courtLabel: court.label, courtId: court.id, dateStr, hour, opponent,
      dryRun: cfg.dryRun, requestData,
    });
    if (r.ok) return r;
    if (r.blockedByCap) return r;           // cap is global — no point trying other courts
    reasons.push(`${court.label}: ${r.reason}`);
  }
  return { ok: false, blockedByCap: false, reason: `no court bookable — ${reasons.join('; ')}` };
}

async function firstOpponent(ctx, names) {
  for (const name of names) {
    const o = await resolveOpponent(ctx, name);
    if (o && o.orgMemberId && o.memberId) return o;
  }
  return null;
}

function hasSlot(bookings, dateStr, hour) {
  return bookings.some((b) => b.localDate === dateStr && b.localHour === hour);
}

// "Cancel any 10 PM": pick the furthest-out one so we sacrifice the least-imminent game.
function pickCancelTarget(bookings, hour) {
  const candidates = bookings
    .filter((b) => b.localHour === hour)
    .sort((a, b) => (a.localDate < b.localDate ? 1 : a.localDate > b.localDate ? -1 : 0));
  return candidates[0] || null;
}

function describeBooking(b) {
  return b.display || `${b.court || 'court'} on ${b.localDate ?? '?'}` || `reservation ${b.id}`;
}
