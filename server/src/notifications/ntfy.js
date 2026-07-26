const NTFY_URL = 'https://ntfy.sh/';

export async function sendNtfyNotification(topic, { title, message, priority = 3, tags = [] }) {
  try {
    const response = await fetch(NTFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic, title, message, priority, tags }),
    });
    if (!response.ok) {
      console.warn(`[ntfy] send failed: HTTP ${response.status}`);
    }
  } catch (err) {
    console.warn(`[ntfy] send failed: ${err.message}`);
  }
}
