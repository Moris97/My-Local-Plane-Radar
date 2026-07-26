import { FileSource } from './FileSource.js';

const DEFAULT_AIRCRAFT_JSON_PATH = '/run/readsb/aircraft.json';

export function createSource(env = process.env) {
  const kind = env.MLPR_SOURCE ?? 'file';

  switch (kind) {
    case 'file':
      return new FileSource(env.MLPR_AIRCRAFT_JSON_PATH ?? DEFAULT_AIRCRAFT_JSON_PATH);
    case 'http':
      throw new Error('MLPR_SOURCE=http (HttpSource) is not implemented yet.');
    case 'replay':
      throw new Error('MLPR_SOURCE=replay (ReplaySource) is not implemented yet.');
    default:
      throw new Error(`Unknown MLPR_SOURCE "${kind}" (expected: file, http, replay)`);
  }
}
