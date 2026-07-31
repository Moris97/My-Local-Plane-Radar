// Fetches aircraft.json/receiver.json/stats.json over plain HTTP from a
// remote readsb (the documented "dev on WSL against live data" mode -- see
// CLAUDE.md). Unlike FileSource's local fs.readFile, a network request can
// simply hang forever with no error and no timeout of its own; Node's
// built-in fetch() has no default timeout. Left unguarded, that's a real
// leak: pollOnce() runs on a plain setInterval (POLL_INTERVAL_MS, index.js)
// that does NOT wait for the previous call to finish before firing the
// next one, so one stalled connection means a new hung request piles up
// on top of it every second, forever, rather than just one slow tick.
const DEFAULT_TIMEOUT_MS = 3000;

async function fetchJson(url, label, timeoutMs) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) {
      console.warn(`[HttpSource] ${label} at ${url} responded with ${response.status}`);
      return null;
    }
    return await response.json();
  } catch (err) {
    console.warn(`[HttpSource] could not fetch ${label} at ${url}: ${err.message}`);
    return null;
  }
}

export class HttpSource {
  constructor(url, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    this.url = new URL(url);
    this.timeoutMs = timeoutMs;
  }

  async fetchSnapshot() {
    return fetchJson(this.url, 'aircraft.json', this.timeoutMs);
  }

  async fetchReceiverInfo() {
    return fetchJson(new URL('receiver.json', this.url), 'receiver.json', this.timeoutMs);
  }

  async fetchStats() {
    return fetchJson(new URL('stats.json', this.url), 'stats.json', this.timeoutMs);
  }
}
