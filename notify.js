// Best-effort notification of the run outcome via Resend (email). If no API key
// is configured it just logs — the agent never fails because of notifications.

export async function notify(cfg, result) {
  const line = summarize(result);
  console.log(`[tennis-agent] ${line}`);

  if (!cfg?.notifyEmail || !cfg?.resendApiKey || !cfg?.resendFrom) return;

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.resendApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: cfg.resendFrom,
        to: cfg.notifyEmail,
        subject: `${result.ok ? '✅' : '❌'} Tennis booking — ${result.date} ${result.hour}`,
        text: line,
      }),
    });
    if (!res.ok) console.warn('[tennis-agent] notify failed:', res.status, await res.text());
  } catch (err) {
    console.warn('[tennis-agent] notify error:', err);
  }
}

function summarize(r) {
  if (r.ok && r.stage === 'booked') {
    return `Booked ${r.court ?? 'a court'} at ${r.hour} on ${r.date}` +
      (r.opponent ? ` vs ${r.opponent}` : '') +
      (r.cancelled ? ` (cancelled ${r.cancelled} to free a slot)` : '');
  }
  if (r.ok && r.stage === 'already-booked') return `Already booked for ${r.date} ${r.hour}; nothing to do.`;
  if (r.ok && r.stage === 'dry-run') return `DRY RUN ok — would book ${r.court ?? 'a court'} at ${r.hour} on ${r.date}.`;
  return `No booking for ${r.date} ${r.hour} — ${r.reason ?? r.error ?? r.stage}.`;
}
