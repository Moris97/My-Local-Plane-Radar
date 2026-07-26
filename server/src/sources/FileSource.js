import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

async function readJson(path, label) {
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    console.warn(`[FileSource] could not read ${label} at ${path}: ${err.message}`);
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch (err) {
    console.warn(`[FileSource] invalid JSON in ${label} at ${path}: ${err.message}`);
    return null;
  }
}

export class FileSource {
  constructor(path) {
    this.path = path;
    this.dir = dirname(path);
  }

  async fetchSnapshot() {
    return readJson(this.path, 'aircraft.json');
  }

  async fetchReceiverInfo() {
    return readJson(join(this.dir, 'receiver.json'), 'receiver.json');
  }

  async fetchStats() {
    return readJson(join(this.dir, 'stats.json'), 'stats.json');
  }
}
