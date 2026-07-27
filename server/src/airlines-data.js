import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dataPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'airlines.json');

function loadAirlines() {
  try {
    const raw = JSON.parse(readFileSync(dataPath, 'utf8'));
    return new Map(Object.entries(raw));
  } catch {
    // Not fetched yet -- fresh clone before scripts/install.sh's fetch step
    // ran, or that fetch failed (offline at install time). Non-fatal:
    // airline names just won't resolve (identifyOperator falls through to
    // 'airline_unknown'/'unknown') until data/airlines.json exists.
    return new Map();
  }
}

const airlines = loadAirlines();

export function getAirlines() {
  return airlines;
}
