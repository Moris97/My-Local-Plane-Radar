import { distanceKm, bearingDegrees } from './range.js';
import { getConfigJSON, setConfigJSON } from './db.js';

const CONFIG_KEY = 'antennaStats';

// Altitude bands for the "range by altitude" bar chart. On-ground aircraft
// (altBaro cleared, onGround: true) count as 0 ft, same convention as the
// watch list's altitude condition -- CLAUDE.md's home.js/notifications
// treat onGround as altitude 0 elsewhere too.
export const ALTITUDE_BANDS = [
  { label: '0–5,000 ft', maxFt: 5000 },
  { label: '5,000–10,000 ft', maxFt: 10000 },
  { label: '10,000–15,000 ft', maxFt: 15000 },
  { label: '15,000–20,000 ft', maxFt: 20000 },
  { label: '20,000–25,000 ft', maxFt: 25000 },
  { label: '25,000–30,000 ft', maxFt: 30000 },
  { label: '30,000–35,000 ft', maxFt: 35000 },
  { label: '35,000–40,000 ft', maxFt: 40000 },
  { label: '40,000+ ft', maxFt: Infinity },
];

// 16-point compass rose for the "directional coverage" chart -- fine enough
// to show a real receiver's typical asymmetry (a building/hill blocking one
// side), coarse enough that 16 all-time maxima stay meaningful rather than
// each being one lucky sample.
export const SECTOR_COUNT = 16;
export const SECTOR_LABELS = [
  'N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
  'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW',
];

let altitudeBandMaxKm = new Array(ALTITUDE_BANDS.length).fill(0);
let sectorMaxKm = new Array(SECTOR_COUNT).fill(0);
let latestSignalDbfs = null;
let latestPeakSignalDbfs = null;
let loaded = false;
let dirty = false;

function ensureLoaded() {
  if (loaded) return;
  loaded = true;
  const stored = getConfigJSON(CONFIG_KEY, null);
  if (stored?.altitudeBandMaxKm?.length === ALTITUDE_BANDS.length) {
    altitudeBandMaxKm = stored.altitudeBandMaxKm.slice();
  }
  if (stored?.sectorMaxKm?.length === SECTOR_COUNT) {
    sectorMaxKm = stored.sectorMaxKm.slice();
  }
}

export function altitudeBandIndex(altBaro, onGround) {
  const ft = onGround ? 0 : altBaro;
  if (typeof ft !== 'number') return -1;
  return ALTITUDE_BANDS.findIndex((band) => ft < band.maxFt);
}

export function sectorIndex(bearing) {
  return Math.floor(((bearing % 360) / 360) * SECTOR_COUNT) % SECTOR_COUNT;
}

// Called once per poll tick per tracked aircraft with a known position
// (same "every tracked aircraft, not just the delta" reasoning as
// index.js's other per-tick sightings -- see recordRangeAndRegistrationSightings).
// Only the running all-time maximum per band/sector is kept; the per-tick
// distance/bearing readings themselves are discarded immediately, same as
// the time-based range sampling in stats-history.js (hard rule 4).
export function recordAntennaSample({ homeLat, homeLon, lat, lon, altBaro, onGround }) {
  ensureLoaded();

  const km = distanceKm(homeLat, homeLon, lat, lon);
  const bandIdx = altitudeBandIndex(altBaro, onGround);
  if (bandIdx !== -1 && km > altitudeBandMaxKm[bandIdx]) {
    altitudeBandMaxKm[bandIdx] = km;
    dirty = true;
  }

  const bearing = bearingDegrees(homeLat, homeLon, lat, lon);
  const secIdx = sectorIndex(bearing);
  if (km > sectorMaxKm[secIdx]) {
    sectorMaxKm[secIdx] = km;
    dirty = true;
  }
}

// Separate from recordAntennaSample above: signal strength is a receiver-
// wide reading from stats.json (last1min.local.signal/peak_signal), polled
// every ~15s by index.js's pollStats -- not a per-aircraft, per-second
// figure, so it doesn't belong in the per-tick per-aircraft loop. Just the
// latest reading, not averaged/persisted -- a live "how's reception right
// now" gauge, same spirit as the existing messages/sec live number.
export function recordSignalReading(signalDbfs, peakSignalDbfs) {
  if (typeof signalDbfs === 'number') latestSignalDbfs = signalDbfs;
  if (typeof peakSignalDbfs === 'number') latestPeakSignalDbfs = peakSignalDbfs;
}

export function getAltitudeBandStats() {
  ensureLoaded();
  return ALTITUDE_BANDS.map((band, i) => ({ label: band.label, maxRangeKm: altitudeBandMaxKm[i] }));
}

export function getSectorStats() {
  ensureLoaded();
  return SECTOR_LABELS.map((label, i) => ({ label, maxRangeKm: sectorMaxKm[i] }));
}

export function getLatestSignal() {
  return { signalDbfs: latestSignalDbfs, peakSignalDbfs: latestPeakSignalDbfs };
}

// Only writes when something actually changed since the last flush -- an
// established antenna's band/sector maxima stop moving after the first
// weeks, so most flush ticks after that point are true no-ops (no SD write
// at all), not just a small one.
export function flushAntennaStatsIfDirty() {
  if (!dirty) return false;
  setConfigJSON(CONFIG_KEY, { altitudeBandMaxKm, sectorMaxKm });
  dirty = false;
  return true;
}

export function resetAntennaStats() {
  altitudeBandMaxKm = new Array(ALTITUDE_BANDS.length).fill(0);
  sectorMaxKm = new Array(SECTOR_COUNT).fill(0);
  latestSignalDbfs = null;
  latestPeakSignalDbfs = null;
  loaded = false;
  dirty = false;
}
