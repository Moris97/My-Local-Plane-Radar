import { networkInterfaces } from 'node:os';

const NTFY_URL = 'https://ntfy.sh/';

// Best-effort: tapping the notification opens the app on whatever device
// receives it (typically the user's phone), so this must be a LAN address
// reachable from there, not "localhost" (which would mean the phone itself).
// Picks the first non-internal IPv4 interface; on a Pi with a single NIC
// that's always the right one. Computed once at startup -- if it's ever
// wrong (multiple NICs), tapping the notification just does nothing useful,
// which is an acceptable trade-off for a feature explicitly marked "nice to
// have, skip if it can't be done cleanly".
function detectLocalUrl() {
  const port = process.env.MLPR_PORT ?? 1090;
  for (const ifaces of Object.values(networkInterfaces())) {
    for (const iface of ifaces ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return `http://${iface.address}:${port}/`;
      }
    }
  }
  return null;
}

const baseClickUrl = detectLocalUrl();

// hex (optional): when the notification is about a specific aircraft,
// deep-links the click straight to it (app.js reads ?select=<hex> on load
// and selects+centers once the aircraft actually shows up) instead of just
// opening the app at whatever it happens to be looking at. Reported live as
// missing -- tapping a push notification used to always land on the bare
// app root regardless of which aircraft it was about. receiver_silence (no
// aircraft at all) and any future hex-less rule still get the plain root
// URL, same best-effort fallback as before.
export async function sendNtfyNotification(topic, { title, message, priority = 3, tags = [], hex }) {
  try {
    const body = { topic, title, message, priority, tags };
    if (baseClickUrl) body.click = hex ? `${baseClickUrl}?select=${encodeURIComponent(hex)}` : baseClickUrl;

    const response = await fetch(NTFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      console.warn(`[ntfy] send failed: HTTP ${response.status}`);
    }
  } catch (err) {
    console.warn(`[ntfy] send failed: ${err.message}`);
  }
}
