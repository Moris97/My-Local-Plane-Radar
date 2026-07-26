import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export class ReplaySource {
  constructor(dir) {
    this.dir = dir;
    this.files = null;
    this.index = 0;
  }

  async loadFileList() {
    let entries;
    try {
      entries = await readdir(this.dir);
    } catch (err) {
      console.warn(`[ReplaySource] could not list ${this.dir}: ${err.message}`);
      entries = [];
    }
    this.files = entries.filter((name) => name.endsWith('.json')).sort();
    if (this.files.length === 0) {
      console.warn(`[ReplaySource] no .json fixtures found in ${this.dir}`);
    }
  }

  async fetchSnapshot() {
    if (this.files === null) {
      await this.loadFileList();
    }
    if (this.files.length === 0) return null;

    const filePath = join(this.dir, this.files[this.index]);
    this.index = (this.index + 1) % this.files.length;

    try {
      const raw = await readFile(filePath, 'utf8');
      return JSON.parse(raw);
    } catch (err) {
      console.warn(`[ReplaySource] could not read ${filePath}: ${err.message}`);
      return null;
    }
  }

  async fetchReceiverInfo() {
    return null;
  }

  async fetchStats() {
    return null;
  }
}
