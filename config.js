// All configuration comes from environment variables (GitHub Actions secrets in
// production, a local .env for testing). Nothing sensitive is ever committed.

function req(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export function loadConfig() {
  return {
    // --- Court Reserve account ---
    portalUrl: process.env.CR_PORTAL_URL || null, // optional; defaults to org login URL
    username: req('CR_USERNAME'),
    password: req('CR_PASSWORD'),

    // --- Booking preferences ---
    targetHour: process.env.CR_TARGET_HOUR ?? '9:00 PM',
    durationMinutes: Number(process.env.CR_DURATION_MIN ?? 60),
    reservationType: process.env.CR_RESERVATION_TYPE ?? 'Singles',
    // Optional comma-separated court preference order, e.g. "Court 3,Court 1".
    courtPreference: (process.env.CR_COURT_PREFERENCE ?? '')
      .split(',').map((s) => s.trim()).filter(Boolean),

    // --- Opponents (tried in order until one can be added) ---
    opponents: (process.env.CR_OPPONENTS ?? 'Angad Dev Singh,Karam Adam')
      .split(',').map((s) => s.trim()).filter(Boolean),

    // --- Max-reservation handling ---
    maxReservations: Number(process.env.CR_MAX_RESERVATIONS ?? 4),
    // When at the cap, cancel any existing reservation at this hour to free a slot.
    cancelHourToFreeSlot: process.env.CR_CANCEL_HOUR ?? '10:00 PM',

    // --- Notifications (optional) ---
    notifyEmail: process.env.CR_NOTIFY_EMAIL ?? null,
    resendApiKey: process.env.RESEND_API_KEY ?? null,
    resendFrom: process.env.RESEND_FROM ?? null,

    // --- Runtime ---
    dryRun: process.env.CR_DRY_RUN === '1',   // do everything except final submit/cancel
    headless: process.env.CR_HEADLESS !== '0',
    discover: process.env.CR_DISCOVER === '1', // dump live JSON shapes and exit
    // Skip the "sleep until 7 AM" arming and run immediately (testing / discovery).
    runNow: process.env.CR_FORCE_NOW === '1' || process.env.CR_DISCOVER === '1',
  };
}
