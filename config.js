// All configuration comes from environment variables (GitHub Actions secrets in
// production, a local .env for testing). Nothing sensitive is ever committed.

function req(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

// Unset GitHub Actions *variables* arrive as empty strings, which slip past `??`.
// Treat undefined OR empty as "use the default".
function envOr(name, def) {
  const v = process.env[name];
  return v === undefined || v === '' ? def : v;
}

export function loadConfig() {
  // --- Booking preferences ---
  // Preferred start times in order of preference; the agent books the best one
  // that's available (e.g. 9 PM, else 8 PM, else 10 PM). CR_TARGET_HOUR (single)
  // still works as a one-off override for manual test runs.
  const targetHours = envOr('CR_TARGET_HOURS',
    envOr('CR_TARGET_HOUR', '9:00 PM,8:00 PM,10:00 PM'))
    .split(',').map((s) => s.trim()).filter(Boolean);

  // Court order of preference. Bare numbers ("2") are accepted as "Court 2".
  const courtPreference = envOr('CR_COURT_PREFERENCE', 'Court 2,Court 3,Court 6,Court 4,Court 5,Court 1')
    .split(',').map((s) => s.trim()).filter(Boolean)
    .map((s) => (/^\d+$/.test(s) ? `Court ${s}` : s));

  return {
    // --- Court Reserve account ---
    portalUrl: process.env.CR_PORTAL_URL || null, // optional; defaults to org login URL
    username: req('CR_USERNAME'),
    password: req('CR_PASSWORD'),

    // --- Booking preferences ---
    targetHours,
    targetHour: targetHours[0],   // first preference (back-compat / logging)
    // Only book courts on weekdays (Mon–Fri); skip Sat/Sun targets entirely.
    weekdaysOnly: envOr('CR_WEEKDAYS_ONLY', '1') !== '0',
    // One-off override (YYYY-MM-DD) for testing; default is today + 6 days.
    targetDate: envOr('CR_TARGET_DATE', '') || null,
    durationMinutes: Number(envOr('CR_DURATION_MIN', 60)),
    reservationType: envOr('CR_RESERVATION_TYPE', 'Singles'),
    courtPreference,

    // --- Opponents (tried in order until one can be added) ---
    opponents: envOr('CR_OPPONENTS', 'Angad Dev Singh,Karam Adam')
      .split(',').map((s) => s.trim()).filter(Boolean),

    // --- Max-reservation handling ---
    maxReservations: Number(envOr('CR_MAX_RESERVATIONS', 4)),
    // When at the cap, cancel any existing reservation at this hour to free a slot.
    cancelHourToFreeSlot: envOr('CR_CANCEL_HOUR', '10:00 PM'),

    // --- Notifications (optional) ---
    notifyEmail: process.env.CR_NOTIFY_EMAIL || null,
    resendApiKey: process.env.RESEND_API_KEY || null,
    resendFrom: process.env.RESEND_FROM || null,

    // --- Runtime ---
    dryRun: process.env.CR_DRY_RUN === '1',   // do everything except final submit/cancel
    headless: process.env.CR_HEADLESS !== '0',
    discover: process.env.CR_DISCOVER === '1', // dump live JSON shapes and exit
    // Skip the "sleep until 7 AM" arming and run immediately (testing / discovery).
    runNow: process.env.CR_FORCE_NOW === '1' || process.env.CR_DISCOVER === '1',
  };
}
