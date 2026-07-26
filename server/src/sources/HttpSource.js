export class HttpSource {
  constructor(url) {
    this.url = url;
  }

  async fetchSnapshot() {
    try {
      const response = await fetch(this.url);
      if (!response.ok) {
        console.warn(`[HttpSource] ${this.url} responded with ${response.status}`);
        return null;
      }
      return await response.json();
    } catch (err) {
      console.warn(`[HttpSource] could not fetch ${this.url}: ${err.message}`);
      return null;
    }
  }
}
