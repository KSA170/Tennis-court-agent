// Booking orchestration. Drives a logged-in session to grab a 9 PM court the
// instant the window opens, with idempotency and the max-reservation cap handled.

import { chromium } from 'playwright';
import { login } from './auth.js';
import {
  bookCourt, resolveOpponent, getMyBookings, cancelReservation,
  courtsToTry, dumpDiscovery,
} from './portal.js';
import { parseHour, clubHourAndDate } from './time.js';
import { membersConfigured } from './constants.js';

/**
 * @returns {Promise<{ok:boolean, stage:string, date:string, hour:string,
 *   court?:string, opponent?:string, cancelled?:string, reason?:string, error?:string}>}
 */
export async function runBooking(cfg, targetDate) {
  const base = { date: targetDate, hour: cfg.targetHour };
  if (!cfg.discover && !membersConfigured()) {
    return { ok: false, stage: 'not-configured', ...base,
      reason: 'CR_MEMBERS_JSON secret is missing or has no "self" member — set it (see README).' };
  }

  const browser = await chromium.launch({ headless: cfg.headless });
  let ctx, page;

  try {
    ({ ctx, page } = await login(browser, cfg));

    // Discovery mode: dump the live JSON shapes (availability, my-bookings, member
    // search) so the parsers can be confirmed, then stop.
    if (cfg.discover) {
      await dumpDiscovery(page, ctx, cfg);
      return { ok: true, stage: 'discover', ...base, reason: 'dumped live JSON shapes' };
    }

    const targetHour = parseHour(cfg.targetHour);   // 21
    const cancelHour = parseHour(cfg.cancelHourToFreeSlot); // 22

    // Idempotency — never double-book the same 9 PM slot.
    let bookings = await getMyBookings(page);
    if (hasSlot(bookings, targetDate, targetHour)) {
      return { ok: true, stage: 'already-booked', ...base, reason: 'reservation already exists' };
    }

    // Resolve an opponent (first one that exists in the club directory).
    const opponent = await firstOpponent(ctx, cfg.opponents);
    if (!opponent) {
      return { ok: false, stage: 'no-opponent', ...base,
        reason: `none of [${cfg.opponents.join(', ')}] could be found in the club directory` };
    }

    // First pass: try to grab a court.
    let booked = await tryAllCourts(page, ctx, cfg, targetDate, targetHour, opponent);
    let cancelled;

    // If the club's cap blocked us, cancel a 10 PM reservation and retry once.
    if (booked.blockedByCap) {
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
      booked = await tryAllCourts(page, ctx, cfg, targetDate, targetHour, opponent);
    }

    if (booked.ok) {
      return { ok: true, stage: cfg.dryRun ? 'dry-run' : 'booked', ...base,
        court: booked.court, opponent: booked.opponent ?? opponent.fullName, cancelled };
    }
    return { ok: false, stage: 'book-failed', ...base, cancelled, reason: booked.reason };
  } catch (err) {
    return { ok: false, stage: 'error', ...base, error: String(err?.message ?? err) };
  } finally {
    await browser.close();
  }
}

/** Attempt each court in preference order; first success wins, cap aborts early. */
async function tryAllCourts(page, ctx, cfg, dateStr, hour, opponent) {
  const reasons = [];
  for (const court of courtsToTry(cfg.courtPreference)) {
    const r = await bookCourt(page, ctx, {
      courtLabel: court.label, courtId: court.id, dateStr, hour, opponent, dryRun: cfg.dryRun,
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
  return bookings.some((b) => {
    if (!b.start) return false;
    const { date, hour: h } = clubHourAndDate(b.start);
    return date === dateStr && h === hour;
  });
}

// "Cancel any 10 PM": pick the furthest-out one so we sacrifice the least-imminent game.
function pickCancelTarget(bookings, hour) {
  const candidates = bookings
    .filter((b) => b.start && clubHourAndDate(b.start).hour === hour)
    .sort((a, b) => b.start - a.start);
  return candidates[0] || null;
}

function describeBooking(b) {
  if (!b.start) return `reservation ${b.id}`;
  const { date } = clubHourAndDate(b.start);
  return `${b.court || 'court'} on ${date} ${b.start.toLocaleTimeString('en-CA', { timeZone: 'America/Toronto', hour: 'numeric', minute: '2-digit' })}`;
}
