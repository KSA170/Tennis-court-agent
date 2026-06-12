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

## The ONE remaining blocker: rendering the create-reservation form
`GET /Online/ReservationsApi/CreateReservation?...` returns an **empty body** for us.
From the HAR, the browser's working request:
- was an **AJAX** call (`x-requested-with: XMLHttpRequest`), and
- carried a **`requestData` session token** in the query string (a long base64-ish blob,
  e.g. `BOYDb7t…`), and
- was preceded by `GET /Online/Reservations/CreateReservationCourtsView/6357?start=…&end=…
  &customSchedulerId=1218&courtLabel=Court 2&returnUrlStartPage=…?sId=1218`
  (referer `…/Online/Reservations/Bookings/6357?sId=1218`).

**Current attempt** (`getSessionTokens` in `src/portal.js`): load the Bookings scheduler
page, regex `requestData` out of the Kendo data-source URLs / JS, and pass it on the
create-form URL (with a referer header). `[tokens]` log line reports whether a token was
found and its length.

**If token replay keeps returning empty**, the likely culprits, in order:
1. `requestData` must come from / be primed by `CreateReservationCourtsView` first
   (call that GET, then the CreateReservation GET) — the HAR did both, back to back.
2. There are multiple `requestData` blobs (member-expanded vs get-list vs create differ
   after a shared prefix) — we may be picking the wrong one; print all candidates.
3. The token is built in JS at click-time, not present statically — then **pivot to
   driving the scheduler UI**: navigate `/Online/Reservations/Bookings/6357?sId=1218`,
   move the Kendo scheduler to the target date, click the 9 PM cell for a court, fill the
   modal (ReservationType "Singles", add opponent via the "members to play with" Kendo
   multiselect), submit. Slower but uses the page's own tokens.

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

## Next concrete step
Run a dry run and read the `[tokens] …` line + `FORM-FETCH DIAGNOSTIC`. If requestData was
found but the form is still empty → implement the `CreateReservationCourtsView`-then-
`CreateReservation` two-step. If no good token → switch to UI-driven booking.
