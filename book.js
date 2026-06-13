// Booking orchestration. Drives a logged-in session to grab a 9 PM court the
// instant the window opens, with idempotency and the max-reservation cap handled.

import { chromium } from 'playwright';
import { login } from './auth.js';
import {
  bookCourt, resolveOpponent, getMyBookings, cancelReservation,
  courtsToTry, dumpDiscovery, getSessionTokens,
  captureAvailabilityProbe, getCourtAvailability,
} from './portal.js';
import { parseHour, clubToday, isWeekend } from './time.js';
import { membersConfigured, COURTS } from './constants.js';

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

/**
 * Daytime "upgrade sweep": for each of my existing weekday bookings sitting at a
 * lower-preference hour (e.g. 10 PM or 8 PM), move it up to a better slot (9 PM,
 * else 8 PM) when one is free. Availability is read FIRST (read-only), and a
 * reservation is never lost:
 *  - Under the cap: book the better slot, then cancel the old one.
 *  - At the cap (no room to hold a 5th): only after availability confirms the
 *    better slot is free, cancel the old one and rebook the better one, rolling
 *    back to the original slot if the rebook fails.
 */
export async function runUpgradeSweep(cfg) {
  const base = { stage: 'upgrade', date: '', hour: cfg.targetHours.join(' > ') };
  if (!membersConfigured()) {
    return { ok: false, ...base, reason: 'CR_MEMBERS_JSON secret is missing or has no "self" member.' };
  }

  const browser = await chromium.launch({ headless: cfg.headless });
  try {
    const { ctx, page } = await login(browser, cfg);
    let bookings = await getMyBookings(page);
    const opponent = await firstOpponent(ctx, cfg.opponents);
    if (!opponent) {
      return { ok: false, ...base, reason: `no opponent found among [${cfg.opponents.join(', ')}]` };
    }
    const { requestData } = await getSessionTokens(page);
    const probe = await captureAvailabilityProbe(page); // for read-only availability checks

    const prefs = cfg.targetHours.map((label) => ({ label, hour: parseHour(label) }));
    const rankOf = (hour) => prefs.findIndex((p) => p.hour === hour);
    const today = clubToday();
    const courtByLabel = new Map(COURTS.map((c) => [c.label, c]));

    // Upgradeable = future weekday bookings whose hour is a preferred hour but not
    // already the top preference (so a strictly-better slot exists to chase).
    const candidates = bookings.filter((b) =>
      b.localDate && b.localHour != null &&
      b.localDate >= today && !isWeekend(b.localDate) &&
      rankOf(b.localHour) > 0);

    const upgraded = [];
    const skipped = [];
    for (const b of candidates) {
      const rank = rankOf(b.localHour);
      const fromLabel = prefs[rank].label;
      // Better hours we don't already hold on that date.
      const betterHours = prefs.slice(0, rank).filter((p) => !hasSlot(bookings, b.localDate, p.hour));
      if (!betterHours.length) continue;

      // Read availability for the date and pick the best free (hour, court).
      const avail = await getCourtAvailability(ctx, probe, b.localDate);
      if (!avail.ok) {
        skipped.push(`${b.localDate} ${fromLabel} — could not read availability${avail.status ? ` (status ${avail.status})` : ''}`);
        continue;
      }
      let target = null;
      for (const bh of betterHours) {
        const court = courtsToTry(cfg.courtPreference).find((c) => !avail.isBusy(c.label, bh.hour));
        if (court) { target = { hour: bh.hour, label: bh.label, court }; break; }
      }
      if (!target) { skipped.push(`${b.localDate} ${fromLabel} — no better slot free`); continue; }

      const book = (courtLabel, courtId, hour) => bookCourt(page, ctx, {
        courtLabel, courtId, dateStr: b.localDate, hour, opponent, dryRun: cfg.dryRun, requestData });
      const toNote = `${b.localDate}: ${fromLabel} → ${target.label} (${target.court.label})`;

      if (bookings.length < cfg.maxReservations) {
        // Under cap: book the better slot first; only then release the old one.
        const booked = await book(target.court.label, target.court.id, target.hour);
        if (!booked.ok) { skipped.push(`${toNote} — booking failed (${booked.reason || '?'})`); continue; }
        const cancelRes = await cancelReservation(page, ctx, b.id, { dryRun: cfg.dryRun });
        upgraded.push(toNote + (!cancelRes.ok && !cfg.dryRun ? ' [WARNING: old slot NOT cancelled — you now hold both]' : ''));
      } else {
        // At cap: availability already confirms the target is free, so free the old
        // slot, then book the better one; roll back to the original if the rebook fails.
        const cancelRes = await cancelReservation(page, ctx, b.id, { dryRun: cfg.dryRun });
        if (!cancelRes.ok) { skipped.push(`${toNote} — could not cancel old slot to make room (${cancelRes.reason || '?'})`); continue; }
        const booked = await book(target.court.label, target.court.id, target.hour);
        if (booked.ok) {
          upgraded.push(toNote);
        } else {
          const orig = courtByLabel.get(b.court);
          const rb = await book(b.court, orig ? orig.id : '', b.localHour);
          skipped.push(`${toNote} — rebook failed (${booked.reason || '?'}); rollback ` +
            (rb.ok || cfg.dryRun ? `OK (kept ${fromLabel})` : 'FAILED — RESERVATION LOST, book manually!'));
        }
      }
      bookings = await getMyBookings(page); // reflect the swap for the next candidate
    }

    const reason = upgraded.length
      ? `upgraded ${upgraded.length}: ${upgraded.join('; ')}`
      : (skipped.length ? `no upgrades made — ${skipped.join('; ')}` : 'no upgradeable bookings found');
    return { ok: true, ...base, upgraded, skipped, reason };
  } catch (err) {
    return { ok: false, ...base, error: String(err?.message ?? err) };
  } finally {
    await browser.close();
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
