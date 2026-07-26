import { readFile } from 'node:fs/promises';

export class FileSource {
  constructor(path) {
    this.path = path;
  }

  async fetchSnapshot() {
    let raw;
    try {
      raw = await readFile(this.path, 'utf8');
    } catch (err) {
      console.warn(`[FileSource] could not read ${this.path}: ${err.message}`);
      return null;
    }

    try {
      return JSON.parse(raw);
    } catch (err) {
      console.warn(`[FileSource] invalid JSON in ${this.path}: ${err.message}`);
      return null;
    }
  }
}
