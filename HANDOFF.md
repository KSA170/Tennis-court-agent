# HANDOFF — Court Reserve tennis booking agent (Don Mills, org 6357)

Status notes for whoever picks this up (a fresh Claude Code session pushing directly
to this repo). Everything here was reverse-engineered from a real HAR capture of one
manual booking + cancel; the HAR is **not** in this repo, so this doc is the source of
truth for the portal's mechanics.

## Goal
Auto-book any **9 PM** court at Don Mills (Court Reserve) the instant the booking window
opens (7:00 AM America/Toronto, 6 days out). Single game vs **Angad Dev Singh** or
**Karam Adam**. Max 4 reservations: if at the cap, cancel any **10 PM** reservation and
book the 9 PM. First-come (not a lottery). Login is username+password (a "Continue with
Google" button also exists but we use the password form).

## STATUS: end-to-end VERIFIED (2026-06-12)
A live run booked Court 1 on 2026-06-18 2 PM vs Angad (`{"stage":"booked"}`) via the
target_date/target_hour workflow inputs — login, tokens, form render, payload, and the
real POST all confirmed. (That test reservation should be cancelled in the portal.)
A live 9 PM attempt returned the genuine per-court "Sorry, no available courts for the
time requested." — that's what book-failed looks like when slots are taken. Remaining
unknowns: the exact wording of the at-cap error (CAP_HINTS regex untested live) and
Karam's member record.

## What WORKS (verified on live runs)
- **Login** — `src/auth.js`. Form fields are `input[name="email"]` / `input[name="password"]`,
  submit button text "Continue". Lands on `/Online/Portal/Index/6357`.
- **Read my reservations** — `getMyBookings` → GET `/api/my-bookings-portal/get-list`
  (captured via page navigation to `/Online/Bookings/List/6357`). Confirmed shape:
  `{ Data: [ { ReservationId, TypeName, CourtsDisplay, IsCanceled,
  ReservationStartDateTime: "2026-06-18T22:00:00" (Toronto wall-clock, NO tz suffix),
  DisplayDateAndTimes } ], IsValid }`. Parser reads date/hour straight off the string
  (never `new Date()`, which would misread it as UTC on the runner).
- **Idempotency** + **cancel-target selection** (`pickCancelTarget` = furthest-out 10 PM).
- **Opponent lookup** — `resolveOpponent` → GET `Api_Reservation_GetMembersToPlayWith`
  returns an ARRAY: `[{ MemberId, OrgMemberId, FirstName, LastName, DisplayName, ... }]`.
  Angad is also hard-cached via `CR_MEMBERS_JSON`. Note: live search rows lack
  MembershipNumber / OrgMemberFamilyId (null) — may matter for Karam; TBD.
- **Cancel** — `cancelReservation` POSTs `/Online/MyProfile/CancelReservation/6357`
  (form scraped from the cancel fragment); returns `{"isValid":true}`.

## RESOLVED 2026-06-12: rendering the create-reservation form
The fix was the HAR's two-step ordering: GET `CreateReservationCourtsView/6357?start=…
&end=…&customSchedulerId=1218&courtLabel=…&returnUrlStartPage=…` (AJAX header + scheduler
referer) immediately before the CreateReservation form GET. The courts-view **response
body carries the right `requestData` token** (140 chars; the scheduler page also exposes
a 280-char sibling with the same prefix — that one is NOT the form token). `primeCourtsView`
in `portal.js` does this per court and its token takes precedence. Verified live: form
rendered, full payload built, dry-run result ok on Court 1.

## The booking POST (once the form renders)
`POST //Online/ReservationsApi/CreateReservation/6357?uiCulture=en-CA`, content-type
`application/x-www-form-urlencoded`, header `x-requested-with: XMLHttpRequest`.
Strategy (`bookCourt`): scrape ALL named fields from the rendered form (this carries
`__RequestVerificationToken`, `RequestData`, `ReservationLotteryGuid`, MembershipId, etc.
already filled), then override `Date` (`YYYY-MM-DD 12:00:00 AM`), `StartTime` (`21:00:00`),
`Duration` (60), `ReservationTypeId` (15214), `CourtId`, `SelectedCourtType` (court label),
`CourtTypeEnum` (2), `CustomSchedulerId` (1218); append `SelectedMembers[0]` = self,
`SelectedMembers[1]` = opponent (OrgMemberId/MemberId/OrgMemberFamilyId/FirstName/LastName/
Email/MembershipNumber/PaidAmt). Success response is JSON `{ isValid: true }` (cap errors
detected via `CAP_HINTS` regex in the body).

## Stable IDs (`src/constants.js`)
ORG_ID 6357 · COST_TYPE_ID/MembershipId 81915 · CUSTOM_SCHEDULER_ID 1218 ·
COURT_TYPE_ENUM 2 · RESERVATION_TYPE_ID 15214 (the single-game type) ·
courts 22711–22716 = Court 1–6 (Court 2 = 22712 confirmed).
Personal records come from the `CR_MEMBERS_JSON` secret (self = Mujib Adam, member
5350846 / orgMember 10321730 / family 2496035 / membership 28342; opponent Angad Dev
Singh = orgMember 10322201 / member 5350861 / membership 28344). Karam not yet known —
resolved live by name.

## Running / testing
- GitHub Actions workflow `book-tennis-court.yml`. Repo is public (free Actions minutes);
  personal data only in secrets. Files are FLAT at the repo root (no `src/` dir); the
  workflow's "Locate app directory" step finds `index.js` wherever it is.
- Secrets: `CR_USERNAME`, `CR_PASSWORD`, `CR_MEMBERS_JSON`.
- **Discovery** run (input `discover ✓`) dumps live JSON shapes. **Dry run** (`dry_run ✓`)
  does everything except the final POST. Manual dispatches run immediately
  (`CR_FORCE_NOW`); only the cron does 7 AM timed arming.
- Each test cycle = push → user clicks Run workflow → read the `[tennis-agent] result: {…}`
  line + any DIAGNOSTIC blocks. (Cannot read the user's Actions logs directly — they paste.)

## Timed (cron) path: idle-hold → arm → sleep → fire (DST-robust, late-tolerant)
`book.js` is split: `prepareBooking` (launch, login, idempotency check, opponent, session
tokens) and `fireBooking` (courts-view + form + POST per court, cap handling). `index.js`:
1. `msUntilOpen > MAX_EARLY_MS` (40 min) → exit; a later cron picks it up nearer open.
2. else idle-sleep (NOT logged in) until ~`ARM_LEAD_MS` (90 s) before open, so the
   session/tokens are fresh; then `prepareBooking`.
3. final precise sleep to 7:00:00.000, then `fireBooking`. NEVER fires before open.
4. **If the runner boots AFTER open (cron delay), it still arms and attempts immediately**
   — a late try is strictly better than none, and idempotency stops double-booking.
Manual runs use `runBooking` = prepare + fire now.

### KNOWN ISSUE — GitHub Actions cron is unreliable (root cause of the 2026-06-13 misses)
GitHub dispatched NO runner until ~75–90 min after the scheduled crons that day, so the
"arm before open, sleep to 7:00:00" never armed before open, and the old code's
`withinBookingWindow` guard then refused to even try (now removed — see step 4). The
workflow now staggers many crons across BOTH seasonal opens (11:00 UTC EDT / 12:00 UTC
EST) with late-attempt fallbacks. This makes a (late) booking likely but CANNOT win the
7:00:00 first-come race — GitHub cron simply isn't punctual enough. To actually win the
race, trigger via an external scheduler (e.g. cron-job.org → `repository_dispatch`, or a
tiny always-on VM) that fires ~3–5 min before open; the in-process sleep then nails the
open. That's the recommended next step if 9 PM prime slots are contested.

## Next concrete step
Let the new staggered schedule run and read the Actions log: which cron actually booted a
runner, the idle/arm/sleep lines, and the result. If 9 PM keeps getting lost to faster
bookers, move the trigger off GitHub cron to an external `repository_dispatch` (above). If
`cap-blocked`/CAP_HINTS misfires at the cap, capture the real error message and tighten the
regex. Cloudflare login challenges are now retried 3× in `auth.js`; if one still slips
through, the `login-no-field` diagnostic + debug artifact will show it.
