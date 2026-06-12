// Court Reserve portal operations, built from the captured flow.
//
// Strategy: let the server render its own forms (create-reservation, cancel) —
// they come pre-filled with the per-session security tokens (__RequestVerificationToken,
// RequestData, ReservationLotteryGuid) and all the correct hidden fields. We scrape
// those exact fields via the browser's own FormData, tweak only what we must
// (time, court, opponent, reason), and POST. This avoids re-deriving tokens and is
// resilient to most markup changes.

import {
  ORG_ID, SELF, COST_TYPE_ID, CUSTOM_SCHEDULER_ID, COURT_TYPE_ENUM,
  RESERVATION_TYPE_ID, COURTS, KNOWN_OPPONENTS,
} from './constants.js';
import { clubInstant, clubDateToString, bookingDateField, startTimeField } from './time.js';

const BASE = 'https://app.courtreserve.com';

// ---------------------------------------------------------------------------
// Create-reservation form
// ---------------------------------------------------------------------------

function createFormUrl(courtLabel, dateStr, hour) {
  const start = clubInstant(dateStr, hour);
  const end = clubInstant(dateStr, hour + 1);
  const q = new URLSearchParams({
    id: ORG_ID, uiCulture: 'en-CA',
    start: clubDateToString(start), end: clubDateToString(end),
    courtType: '', courtTypeId: '', courtLabel,
    customSchedulerId: CUSTOM_SCHEDULER_ID, isConsolidated: 'False',
    instructorId: '', isMobileLayout: 'False', useNewTemplate: 'False',
    returnUrlStartPage: `${BASE}/Online/Reservations/Bookings/${ORG_ID}`,
  });
  return `${BASE}/Online/ReservationsApi/CreateReservation?${q.toString()}`;
}

/** Load the create form for a court/time and scrape its exact submission fields. */
async function scrapeCreateForm(page, courtLabel, dateStr, hour) {
  await page.goto(createFormUrl(courtLabel, dateStr, hour), { waitUntil: 'domcontentloaded' });
  const fields = await page.evaluate(() => {
    const anchor = document.querySelector('input[name="RequestData"], input[name="ReservationTypeId"]');
    const form = anchor && anchor.closest('form');
    if (!form) return null;
    return [...new FormData(form).entries()].map(([name, value]) => ({ name, value: String(value) }));
  });
  return fields; // null if the form didn't render (slot unavailable / not yet open)
}

/**
 * Book `courtLabel` at the target date/hour with `opponent` attached.
 * @returns {{ok:boolean, blockedByCap:boolean, court?:string, opponent?:string, reason?:string}}
 */
export async function bookCourt(page, ctx, { courtLabel, courtId, dateStr, hour, opponent, dryRun }) {
  const scraped = await scrapeCreateForm(page, courtLabel, dateStr, hour);
  if (!scraped) return { ok: false, blockedByCap: false, reason: `create form did not render for ${courtLabel}` };

  // Start from the server's own fields, then enforce our booking specifics.
  const params = new URLSearchParams();
  const set = new Set([
    'Date', 'StartTime', 'Duration', 'ReservationTypeId', 'CourtId',
    'SelectedCourtType', 'CourtTypeEnum', 'CustomSchedulerId',
  ]);
  for (const { name, value } of scraped) {
    if (set.has(name)) continue;                       // we'll set these explicitly
    if (/^SelectedMembers\[\d+\]/.test(name)) continue; // re-built below
    params.append(name, value);
  }
  params.append('Date', bookingDateField(dateStr));
  params.append('StartTime', startTimeField(hour));
  params.append('Duration', String(scraped.find((f) => f.name === 'Duration')?.value || 60));
  params.append('ReservationTypeId', RESERVATION_TYPE_ID);
  params.append('CourtId', courtId);
  params.append('SelectedCourtType', courtLabel);
  params.append('CourtTypeEnum', COURT_TYPE_ENUM);
  params.append('CustomSchedulerId', CUSTOM_SCHEDULER_ID);

  // Player 0 = me, player 1 = opponent.
  appendMember(params, 0, SELF);
  appendMember(params, 1, opponent);
  params.append('X-Requested-With', 'XMLHttpRequest');

  if (dryRun) {
    return { ok: true, blockedByCap: false, court: courtLabel, opponent: opponent.fullName,
      reason: 'dry-run: payload built, POST skipped' };
  }

  const res = await ctx.request.post(`${BASE}/Online/ReservationsApi/CreateReservation/${ORG_ID}?uiCulture=en-CA`, {
    headers: {
      'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'x-requested-with': 'XMLHttpRequest',
    },
    data: params.toString(),
  });
  const body = await res.text();
  return interpretBookingResponse(res.status(), body, courtLabel, opponent.fullName);
}

function appendMember(params, i, m) {
  params.append(`SelectedMembers[${i}].OrgMemberId`, m.orgMemberId);
  params.append(`SelectedMembers[${i}].MemberId`, m.memberId);
  params.append(`SelectedMembers[${i}].OrgMemberFamilyId`, m.orgMemberFamilyId ?? '');
  params.append(`SelectedMembers[${i}].FirstName`, m.firstName);
  params.append(`SelectedMembers[${i}].LastName`, m.lastName);
  params.append(`SelectedMembers[${i}].Email`, m.email ?? '');
  params.append(`SelectedMembers[${i}].MembershipNumber`, m.membershipNumber ?? '');
  params.append(`SelectedMembers[${i}].PaidAmt`, '');
}

const CAP_HINTS = /maximum|max(imum)?\s*reservation|reached|limit|too many|exceed|allowed to (book|make)/i;

function interpretBookingResponse(status, body, court, opponent) {
  let json = null;
  try { json = JSON.parse(body); } catch { /* HTML or empty */ }
  const valid = json && (json.isValid === true || json.IsValid === true);
  const msg = (json && (json.message || json.Message || json.errorMessage)) || body || '';

  if (valid) return { ok: true, blockedByCap: false, court, opponent };
  if (CAP_HINTS.test(String(msg))) return { ok: false, blockedByCap: true, reason: String(msg).slice(0, 200) };
  return { ok: false, blockedByCap: false, reason: `status ${status}: ${String(msg).slice(0, 200) || 'booking rejected'}` };
}

// ---------------------------------------------------------------------------
// Opponent lookup
// ---------------------------------------------------------------------------

/** Resolve an opponent by name to the member fields the booking needs. */
export async function resolveOpponent(ctx, name) {
  if (KNOWN_OPPONENTS[name]) return { ...KNOWN_OPPONENTS[name], fullName: name };

  const q = new URLSearchParams({
    id: ORG_ID, costTypeId: COST_TYPE_ID, filterValue: name,
    organizationMemberIdsString: '', userId: SELF.memberId,
    customSchedulerId: '', isOpenReservation: 'false',
    'filter[filters][0][value]': name,
    'filter[filters][0][field]': 'DisplayName',
    'filter[filters][0][operator]': 'contains',
    'filter[filters][0][ignoreCase]': 'true',
    'filter[logic]': 'and',
  });
  const res = await ctx.request.get(
    `${BASE}/api/v1/portalreservationsapi/Api_Reservation_GetMembersToPlayWith?${q.toString()}`
  );
  if (!res.ok()) return null;
  const data = await res.json().catch(() => null);
  const rows = Array.isArray(data) ? data : (data?.Data || data?.data || data?.Results || []);
  const r = rows[0];
  if (!r) return null;
  return {
    fullName: r.DisplayName || r.FullName || name,
    orgMemberId: String(r.OrgMemberId ?? r.Id ?? ''),
    memberId: String(r.MemberId ?? r.UserId ?? ''),
    orgMemberFamilyId: String(r.OrgMemberFamilyId ?? ''),
    firstName: r.FirstName ?? name.split(' ')[0],
    lastName: r.LastName ?? name.split(' ').slice(1).join(' '),
    email: r.Email ?? '',
    membershipNumber: String(r.MembershipNumber ?? ''),
  };
}

// ---------------------------------------------------------------------------
// My bookings (for idempotency + the max-cap cancel path)
// ---------------------------------------------------------------------------

/** Navigate the bookings list and capture the get-list JSON the page fetches. */
export async function getMyBookings(page) {
  const [resp] = await Promise.all([
    page.waitForResponse(
      (r) => r.url().includes('/api/my-bookings-portal/get-list') &&
             r.request().method() === 'GET' && r.status() === 200,
      { timeout: 25000 }
    ).catch(() => null),
    page.goto(`${BASE}/Online/Bookings/List/${ORG_ID}`, { waitUntil: 'domcontentloaded' }),
  ]);
  if (!resp) return [];
  const data = await resp.json().catch(() => null);
  return parseBookings(data);
}

// Confirmed shape from a live discovery run: { Data: [ { ReservationId, TypeName,
// CourtsDisplay, ReservationStartDateTime: "2026-06-18T22:00:00" (Toronto wall-clock,
// NO timezone suffix), IsCanceled, ... } ], IsValid }.
// We read the date/hour straight off the string — never via new Date(), which would
// misinterpret the un-zoned time as UTC on the runner.
function parseBookings(data) {
  if (!data) return [];
  const rows = Array.isArray(data) ? data : (data.Data || data.data || data.Results || data.results || []);
  return rows.map((r) => {
    const raw = r.ReservationStartDateTime || r.Start || r.StartDate || r.ReservationStart || '';
    const m = typeof raw === 'string' && raw.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
    return {
      id: String(r.ReservationId ?? r.Id ?? r.id ?? ''),
      court: r.CourtsDisplay || r.CourtLabel || r.Court || r.CourtName || '',
      canceled: !!(r.IsCanceled ?? r.IsCancelled),
      localDate: m ? `${m[1]}-${m[2]}-${m[3]}` : null, // YYYY-MM-DD, Toronto-local
      localHour: m ? Number(m[4]) : null,              // 0–23, Toronto-local
      display: r.DisplayDateAndTimes || raw || '',
      type: r.TypeName || '',
      raw: r,
    };
  }).filter((b) => b.id && !b.canceled);
}

// ---------------------------------------------------------------------------
// Cancel (uses the server-rendered cancel form, same approach as create)
// ---------------------------------------------------------------------------

export async function cancelReservation(page, ctx, reservationId, { reason = 'Weather', dryRun } = {}) {
  await page.goto(`${BASE}/Online/MyProfile/CancelReservation/${ORG_ID}?reservationId=${reservationId}`,
    { waitUntil: 'domcontentloaded' });
  const fields = await page.evaluate(() => {
    const anchor = document.querySelector('input[name="SelectedReservation.Id"]');
    const form = anchor && anchor.closest('form');
    if (!form) return null;
    return [...new FormData(form).entries()].map(([name, value]) => ({ name, value: String(value) }));
  });
  if (!fields) return { ok: false, reason: `cancel form did not render for ${reservationId}` };

  const params = new URLSearchParams();
  for (const { name, value } of fields) {
    if (name === 'SelectedReservation.CancellationReason') continue;
    params.append(name, value);
  }
  params.append('SelectedReservation.CancellationReason', reason);
  params.append('X-Requested-With', 'XMLHttpRequest');

  if (dryRun) return { ok: true, reason: 'dry-run: cancel payload built, POST skipped' };

  const res = await ctx.request.post(`${BASE}/Online/MyProfile/CancelReservation/${ORG_ID}`, {
    headers: {
      'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'x-requested-with': 'XMLHttpRequest',
    },
    data: params.toString(),
  });
  const body = await res.text();
  let json = null; try { json = JSON.parse(body); } catch { /* */ }
  return { ok: !!(json && (json.isValid === true || json.IsValid === true)),
    reason: json ? '' : `status ${res.status()}: ${body.slice(0, 120)}` };
}

// ---------------------------------------------------------------------------
// Discovery — dump the live JSON shapes the HAR didn't capture, so the parsers
// above (parseBookings, resolveOpponent, availability) can be confirmed.
// ---------------------------------------------------------------------------

export async function dumpDiscovery(page, ctx, cfg) {
  const log = (label, obj) => {
    const s = typeof obj === 'string' ? obj : JSON.stringify(obj);
    console.log(`\n========== ${label} ==========\n${s.slice(0, 4000)}`);
  };

  // my-bookings get-list
  const [listResp] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/api/my-bookings-portal/get-list') &&
      r.request().method() === 'GET' && r.status() === 200, { timeout: 25000 }).catch(() => null),
    page.goto(`${BASE}/Online/Bookings/List/${ORG_ID}`, { waitUntil: 'domcontentloaded' }),
  ]);
  log('GET-LIST (my bookings) raw', listResp ? await listResp.json().catch(() => '<non-json>') : '<not captured>');

  // availability member-expanded (whatever the bookings scheduler fetches)
  const [availResp] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/api/scheduler/member-expanded') &&
      r.request().method() === 'GET' && r.status() === 200, { timeout: 25000 }).catch(() => null),
    page.goto(`${BASE}/Online/Reservations/Bookings/${ORG_ID}`, { waitUntil: 'domcontentloaded' }),
  ]);
  log('MEMBER-EXPANDED (availability) raw', availResp ? await availResp.json().catch(() => '<non-json>') : '<not captured>');

  // opponent search
  const name = cfg.opponents[0] || 'Angad';
  const q = new URLSearchParams({
    id: ORG_ID, costTypeId: COST_TYPE_ID, filterValue: name,
    organizationMemberIdsString: '', userId: SELF.memberId, customSchedulerId: '',
    isOpenReservation: 'false', 'filter[filters][0][value]': name,
    'filter[filters][0][field]': 'DisplayName', 'filter[filters][0][operator]': 'contains',
    'filter[filters][0][ignoreCase]': 'true', 'filter[logic]': 'and',
  });
  const mRes = await ctx.request.get(
    `${BASE}/api/v1/portalreservationsapi/Api_Reservation_GetMembersToPlayWith?${q.toString()}`);
  log(`MEMBERS-TO-PLAY-WITH ("${name}") raw`, mRes.ok() ? await mRes.json().catch(() => '<non-json>') : `<status ${mRes.status()}>`);
}

// ---------------------------------------------------------------------------
// Court ordering helper
// ---------------------------------------------------------------------------

/** Courts to attempt, honoring an optional preferred-label order, else all courts. */
export function courtsToTry(preference = []) {
  if (!preference.length) return COURTS.slice();
  const byLabel = new Map(COURTS.map((c) => [c.label.toLowerCase(), c]));
  const ordered = [];
  for (const p of preference) {
    const c = byLabel.get(p.toLowerCase());
    if (c) { ordered.push(c); byLabel.delete(p.toLowerCase()); }
  }
  return ordered.concat([...byLabel.values()]);
}
