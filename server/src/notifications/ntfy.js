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

const clickUrl = detectLocalUrl();

export async function sendNtfyNotification(topic, { title, message, priority = 3, tags = [] }) {
  try {
    const body = { topic, title, message, priority, tags };
    if (clickUrl) body.click = clickUrl;

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
