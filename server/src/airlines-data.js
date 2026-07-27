import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Overridable for tests, same pattern as db.js's MLPR_DB_PATH.
const dataPath = process.env.MLPR_AIRLINES_PATH ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'airlines.json');

let airlines = new Map();
let loadedMtimeMs = 0;

// Re-checks the file's mtime (one cheap stat call, no read unless it
// actually changed) on every call rather than loading once at startup --
// otherwise a server started before scripts/fetch-airlines.sh has ever run
// (fresh clone, or an existing install upgrading to this feature without
// re-running install.sh) stays stuck with an empty map forever, even after
// the file gets fetched later, until the process is restarted. This way
// fetching it while the server is already running is picked up within one
// poll tick.
function reloadIfChanged() {
  let stat;
  try {
    stat = statSync(dataPath);
  } catch {
    return; // not fetched yet -- keep whatever we have (empty, or the last good load)
  }
  if (stat.mtimeMs === loadedMtimeMs) return;
  try {
    const raw = JSON.parse(readFileSync(dataPath, 'utf8'));
    airlines = new Map(Object.entries(raw));
    loadedMtimeMs = stat.mtimeMs;
  } catch {
    // Mid-write or corrupt -- keep the previous map rather than clearing it.
  }
}

export function getAirlines() {
  reloadIfChanged();
  return airlines;
}
