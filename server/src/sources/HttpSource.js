async function fetchJson(url, label) {
  try {
    const response = await fetch(url);
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
  constructor(url) {
    this.url = new URL(url);
  }

  async fetchSnapshot() {
    return fetchJson(this.url, 'aircraft.json');
  }

  async fetchReceiverInfo() {
    return fetchJson(new URL('receiver.json', this.url), 'receiver.json');
  }

  async fetchStats() {
    return fetchJson(new URL('stats.json', this.url), 'stats.json');
  }
}
