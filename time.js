// Time helpers, all anchored to the club's local zone (Don Mills / Toronto).
// Using America/Toronto means DST transitions are handled automatically.

const CLUB_TZ = 'America/Toronto';

// How many days ahead the booking window opens. The club releases one new day
// at a time, 6 days in advance, at 7 AM local.
export const BOOKING_LEAD_DAYS = 6;

// The hour (local) at which the new day becomes bookable.
export const OPEN_HOUR = 7;

/** Returns the wall-clock parts (Y/M/D/h/m/s) for `date` in the club's zone. */
function partsInClubTz(date = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: CLUB_TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
  const p = Object.fromEntries(fmt.formatToParts(date).map((x) => [x.type, x.value]));
  return {
    year: +p.year, month: +p.month, day: +p.day,
    hour: +p.hour === 24 ? 0 : +p.hour, minute: +p.minute, second: +p.second,
  };
}

/** Today's date in the club zone as 'YYYY-MM-DD'. */
export function clubToday(date = new Date()) {
  const { year, month, day } = partsInClubTz(date);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** The date that newly opens for booking at 7 AM today = today + BOOKING_LEAD_DAYS. */
export function targetBookingDate(date = new Date()) {
  const { year, month, day } = partsInClubTz(date);
  // Build a UTC date from the club-local Y/M/D, add lead days, read it back.
  const d = new Date(Date.UTC(year, month - 1, day));
  d.setUTCDate(d.getUTCDate() + BOOKING_LEAD_DAYS);
  return d.toISOString().slice(0, 10);
}

/**
 * Milliseconds from `now` until the next OPEN_HOUR:00:00.000 in the club zone.
 * Negative if we're already past it (caller should then fire immediately).
 */
export function msUntilOpen(now = new Date()) {
  const { hour, minute, second } = partsInClubTz(now);
  const ms = now.getMilliseconds();
  const secondsNow = hour * 3600 + minute * 60 + second + ms / 1000;
  const secondsOpen = OPEN_HOUR * 3600;
  return Math.round((secondsOpen - secondsNow) * 1000);
}

/** True if club-local time is within `windowMin` minutes after OPEN_HOUR. */
export function withinBookingWindow(now = new Date(), windowMin = 10) {
  const delta = -msUntilOpen(now); // ms since open
  return delta >= -90_000 && delta <= windowMin * 60_000; // allow arming up to 90s early
}

// --- Booking-time formatting helpers (match the formats Court Reserve expects) ---

/** Parse "9:00 PM" / "9 PM" / "21:00" into a 24h hour number. */
export function parseHour(label) {
  const s = String(label).trim();
  const m = s.match(/^(\d{1,2})(?::(\d{2}))?\s*([ap]m)?$/i);
  if (!m) throw new Error(`Cannot parse hour: ${label}`);
  let h = +m[1];
  const ampm = m[3]?.toLowerCase();
  if (ampm === 'pm' && h < 12) h += 12;
  if (ampm === 'am' && h === 12) h = 0;
  return h;
}

/** Minutes east of UTC for `date` in the club zone (e.g. -240 EDT, -300 EST). */
function clubOffsetMinutes(date) {
  const { year, month, day, hour, minute, second } = partsInClubTz(date);
  const asUTC = Date.UTC(year, month - 1, day, hour, minute, second);
  return Math.round((asUTC - date.getTime()) / 60000);
}

/** The absolute instant of `hour`:00 club-local on a 'YYYY-MM-DD' date. */
export function clubInstant(dateStr, hour, minute = 0) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, hour, minute, 0);
  let off = clubOffsetMinutes(new Date(guess));
  let utc = guess - off * 60000;
  off = clubOffsetMinutes(new Date(utc)); // settle DST edges
  return new Date(guess - off * 60000);
}

/** "2026-06-18 12:00:00 AM" — the Date form field (target date at midnight). */
export function bookingDateField(dateStr) {
  return `${dateStr} 12:00:00 AM`;
}

/** "21:00:00" — the StartTime form field. */
export function startTimeField(hour) {
  return `${String(hour).padStart(2, '0')}:00:00`;
}

/**
 * JS Date.toString-style string the create-reservation form GET expects, e.g.
 * "Thu Jun 18 2026 21:00:00 GMT-0400 (Eastern Daylight Time)".
 */
export function clubDateToString(instant) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: CLUB_TZ, weekday: 'short', month: 'short', day: '2-digit',
    year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const p = Object.fromEntries(f.formatToParts(instant).map((x) => [x.type, x.value]));
  const offMin = clubOffsetMinutes(instant);
  const sign = offMin <= 0 ? '-' : '+';
  const abs = Math.abs(offMin);
  const off = `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}${String(abs % 60).padStart(2, '0')}`;
  const longName = new Intl.DateTimeFormat('en-US', { timeZone: CLUB_TZ, timeZoneName: 'long' })
    .formatToParts(instant).find((x) => x.type === 'timeZoneName').value;
  const hh = p.hour === '24' ? '00' : p.hour;
  return `${p.weekday} ${p.month} ${p.day} ${p.year} ${hh}:${p.minute}:${p.second} GMT${off} (${longName})`;
}

/** Club-local date string + hour for an absolute instant (for matching bookings). */
export function clubHourAndDate(date) {
  const { year, month, day, hour } = partsInClubTz(date);
  return {
    date: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    hour,
  };
}

export { CLUB_TZ, partsInClubTz };
