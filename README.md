# Tennis Court Agent — Don Mills Tennis Club

Automatically reserves an evening court at Don Mills Tennis Club through the
Court Reserve member portal, the moment the booking window opens (7:00 AM
America/Toronto, 6 days out), so you don't have to race for it manually.

## What it does

1. **Arms early** on GitHub Actions and sleeps until exactly **7:00:00 Toronto time**;
   if GitHub dispatches the runner late, it still attempts the booking immediately.
2. **Weekdays only** — skips targets that land on a Saturday or Sunday.
3. Logs into the portal and checks you don't already hold a preferred slot (idempotent).
4. Opens the newly-released day (**today + 6 days**) and books the **best available
   preferred time** — **9 PM, else 8 PM, else 10 PM** — trying courts in order
   **2, 3, 6, 4, 5, 1**.
5. Books it as a **Singles** game and adds your opponent — tries **Angad Dev Singh**,
   then **Karam Adam**.
6. **Max-4 handling:** if the club's 4-reservation cap blocks the booking, it cancels
   **any existing 10 PM reservation** to free a slot, then books the better time.
7. Emails you the outcome (optional).

## Status

✅ Everything is built: form login, availability/booking via the portal's own APIs,
opponent attach, idempotency, max-4 cap handling, scheduling, notifications.
🔎 Two JSON response shapes (my-bookings list, opponent search) weren't in the capture,
so the parsers use best-guess field names confirmed by a one-time **discovery run**
(step 1 below) — defaults already work for booking; discovery just hardens the cap/cancel
and search paths.

The flow was mapped from a real capture. Stable IDs (org `6357`, courts `22711–22716`,
reservation type `15214`, your member record) live in `src/constants.js`.

---

## 1. First run: discovery → dry run → live

Do these once, in order, from the **Actions** tab (or locally — see below):

1. **Discovery** — Run workflow with **discover ✓**. It logs in and prints the live
   JSON for my-bookings / availability / opponent-search to the run log. Send me that
   log (or check it yourself) so the parsers are confirmed against real data.
2. **Dry run** — Run workflow with **dry run ✓** (discover off). It does everything —
   finds a court, builds the real booking payload, handles the cap — but **skips the
   final submit/cancel**. The log shows exactly what it *would* do.
3. **Go live** — uncheck dry run, or just let the daily schedule fire at 7 AM.

---

## 2. Check your login security

I need to know if logging in requires a **one-time code (2FA)**:
- Log out of the portal, then log back in from a private/incognito window.
- If it only asks for **email + password** → no 2FA, fully unattended runs work. ✅
- If it texts/emails you a **code** → tell me; we'll add an attended step or app-password.

---

## 3. Configure secrets & variables (GitHub)

In the GitHub repo: **Settings → Secrets and variables → Actions**.

**Secrets** (encrypted — credentials):

| Secret | Value |
|---|---|
| `CR_USERNAME` | Court Reserve username / email |
| `CR_PASSWORD` | Court Reserve password |
| `CR_MEMBERS_JSON` | One line of JSON with your `self` member record (+ optional opponents). Keeps personal data out of the public repo — see `.env.example` for the shape. |
| `RESEND_API_KEY` | *(optional)* for email notifications — https://resend.com |

*(The login URL defaults to the Don Mills org page — set `CR_PORTAL_URL` only if it ever changes.)*

**Variables** (non-secret tuning — all optional, defaults shown):

| Variable | Default | Notes |
|---|---|---|
| `CR_TARGET_HOURS` | `9:00 PM,8:00 PM,10:00 PM` | Preferred times, best first; books the best available |
| `CR_TARGET_HOUR` | *(unset)* | One-off single-time override (e.g. manual test runs) |
| `CR_WEEKDAYS_ONLY` | `1` | `1` = only book Mon–Fri targets; `0` = allow weekends |
| `CR_DURATION_MIN` | `60` | Court duration |
| `CR_RESERVATION_TYPE` | `Singles` | Exact label in the portal |
| `CR_COURT_PREFERENCE` | `Court 2,Court 3,Court 6,Court 4,Court 5,Court 1` | Tried in order; bare numbers OK |
| `CR_OPPONENTS` | `Angad Dev Singh,Karam Adam` | Tried in order |
| `CR_MAX_RESERVATIONS` | `4` | Club cap |
| `CR_CANCEL_HOUR` | `10:00 PM` | Hour to cancel when at the cap |
| `CR_NOTIFY_EMAIL` | *(none)* | Where to email results |
| `RESEND_FROM` | *(none)* | e.g. `Tennis Bot <bot@yourdomain.com>` |

---

## 4. Run it

- **Manual / dry run:** Actions tab → **Book tennis court** → **Run workflow** →
  keep *Dry run* checked. It does everything except the final submit/cancel.
- **Live:** uncheck *Dry run*, or let the daily schedule fire.
- **Local test:** copy `.env.example` to `.env`, fill it, then `npm run dry-run`.

## Local development

```bash
cd tennis-agent
npm install
npx playwright install chromium
npm run dry-run        # set CR_HEADLESS=0 to watch the browser
```

## Caveats

- Automating bookings may conflict with the club's or Court Reserve's terms — this is
  for your own personal membership; confirm you're comfortable with it.
- If the portal shows a **CAPTCHA**, unattended login may need a fallback.
- Portal HTML can change and break selectors; failures email you and upload debug
  artifacts (screenshots) to the workflow run.
