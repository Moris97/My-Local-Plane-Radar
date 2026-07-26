import { fileURLToPath } from 'node:url';
import { FileSource } from './FileSource.js';
import { HttpSource } from './HttpSource.js';
import { ReplaySource } from './ReplaySource.js';

const DEFAULT_AIRCRAFT_JSON_PATH = '/run/readsb/aircraft.json';
const DEFAULT_FIXTURES_DIR = fileURLToPath(new URL('../../../fixtures', import.meta.url));

export function createSource(env = process.env) {
  const kind = env.MLPR_SOURCE ?? 'file';

  switch (kind) {
    case 'file':
      return new FileSource(env.MLPR_AIRCRAFT_JSON_PATH ?? DEFAULT_AIRCRAFT_JSON_PATH);
    case 'http':
      if (!env.MLPR_AIRCRAFT_JSON_URL) {
        throw new Error('MLPR_SOURCE=http requires MLPR_AIRCRAFT_JSON_URL to be set.');
      }
      return new HttpSource(env.MLPR_AIRCRAFT_JSON_URL);
    case 'replay':
      return new ReplaySource(env.MLPR_FIXTURES_DIR ?? DEFAULT_FIXTURES_DIR);
    default:
      throw new Error(`Unknown MLPR_SOURCE "${kind}" (expected: file, http, replay)`);
  }
}
