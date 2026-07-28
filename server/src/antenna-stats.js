import { distanceKm, bearingDegrees } from './range.js';
import { getConfigJSON, setConfigJSON } from './db.js';

const CONFIG_KEY = 'antennaStats';

// Altitude bands for the "range by altitude" bar chart and the map coverage
// layer's per-band views. On-ground aircraft (altBaro cleared, onGround:
// true) count as 0 ft, same convention as the watch list's altitude
// condition -- CLAUDE.md's home.js/notifications treat onGround as
// altitude 0 elsewhere too.
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

// 5° per sector: at a strong receiver's realistic max range (roughly
// 300-400 km), one sector "speaks for" only ~25-35 km of arc -- fine enough
// that a single sector no longer flattens a wide swath of real geography
// into one value, without going so fine that most sectors sit at zero for
// a typical home receiver's traffic density (the user's own tradeoff:
// resolution vs. having enough real samples per sector to be meaningful).
// Easy constant to retune later; nothing else hardcodes this number.
export const SECTOR_COUNT = 72;

// One extra internal-only slot for samples with no altitude data at all
// (Mode-S-only contacts, or a transient decode gap) -- these still carry
// real directional information and contributed to the old single sector-
// only tracking, so they're kept, just excluded from any specific named
// altitude band (getAltitudeBandStats, and the map's per-band views only
// ever iterate the 9 real ALTITUDE_BANDS above).
const UNKNOWN_BAND_SLOT = ALTITUDE_BANDS.length;
const BAND_SLOTS = ALTITUDE_BANDS.length + 1;

// Per (altitude band, sector) cell, only the best TOP_K samples ever
// recorded are kept -- not a single running max (that's exactly what makes
// VRS's/tar1090's coverage plots so spiky: one MLAT glitch or one unusually
// lucky contact creates a permanent spike) and not full history (hard rule
// 4 -- this must never grow into raw position history). Averaging the
// retained K dilutes a single outlier against a handful of realistic
// samples, while the single max is still available for free (it's just the
// largest element) for anyone who wants the honest "best ever" figure too.
// Storage is bounded regardless of how long the receiver runs: BAND_SLOTS *
// SECTOR_COUNT * TOP_K numbers, a few thousand floats, comfortably a few
// hundred KB of JSON at most -- trivial for a config blob.
const TOP_K = 5;

function createEmptyCells() {
  return Array.from({ length: BAND_SLOTS }, () => Array.from({ length: SECTOR_COUNT }, () => []));
}

let cells = createEmptyCells();
let latestSignalDbfs = null;
let latestPeakSignalDbfs = null;
let loaded = false;
let dirty = false;

function ensureLoaded() {
  if (loaded) return;
  loaded = true;
  const stored = getConfigJSON(CONFIG_KEY, null);
  const validShape =
    Array.isArray(stored?.cells) &&
    stored.cells.length === BAND_SLOTS &&
    stored.cells.every((band) => Array.isArray(band) && band.length === SECTOR_COUNT);
  if (validShape) {
    cells = stored.cells.map((band) => band.map((cell) => cell.slice()));
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

// Keeps `list` sorted descending, capped at TOP_K. Returns true if the
// value was actually retained (i.e. something changed, for the dirty flag).
function insertIntoTopK(list, value) {
  if (list.length < TOP_K) {
    list.push(value);
    list.sort((a, b) => b - a);
    return true;
  }
  if (value <= list[list.length - 1]) return false;
  list[list.length - 1] = value;
  list.sort((a, b) => b - a);
  return true;
}

// Called once per poll tick per tracked aircraft with a known position
// (same "every tracked aircraft, not just the delta" reasoning as
// index.js's other per-tick sightings -- see recordRangeAndRegistrationSightings).
export function recordAntennaSample({ homeLat, homeLon, lat, lon, altBaro, onGround }) {
  ensureLoaded();

  const km = distanceKm(homeLat, homeLon, lat, lon);
  const bandIdx = altitudeBandIndex(altBaro, onGround);
  const slot = bandIdx === -1 ? UNKNOWN_BAND_SLOT : bandIdx;
  const secIdx = sectorIndex(bearingDegrees(homeLat, homeLon, lat, lon));

  if (insertIntoTopK(cells[slot][secIdx], km)) {
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

function mergeTopK(lists) {
  return lists.flat().sort((a, b) => b - a).slice(0, TOP_K);
}

function statsFromTopK(list) {
  if (list.length === 0) return { maxRangeKm: 0, topAvgRangeKm: 0 };
  const maxRangeKm = list[0];
  const topAvgRangeKm = list.reduce((sum, v) => sum + v, 0) / list.length;
  return { maxRangeKm, topAvgRangeKm };
}

// One entry per named altitude band, merged across every sector -- "how far
// has this band ever reached, in any direction". maxRangeKm is the single
// best-ever sample; topAvgRangeKm is the outlier-resistant average of the
// best few, the more representative "typical excellent reception" figure.
export function getAltitudeBandStats() {
  ensureLoaded();
  return ALTITUDE_BANDS.map((band, bandIdx) => ({ label: band.label, ...statsFromTopK(mergeTopK(cells[bandIdx])) }));
}

// One entry per sector (bearing), merged across the requested altitude
// band(s). bandIndex null (default) merges every band, including the
// unknown-altitude slot -- "how far in this direction, regardless of
// altitude", matching what the old single sector-only tracking covered.
// Passing a specific 0..8 index (an ALTITUDE_BANDS position) restricts to
// just that band, for the map layer's per-band coverage view.
export function getSectorStats(bandIndex = null) {
  ensureLoaded();
  const bandIndexes = bandIndex === null ? Array.from({ length: BAND_SLOTS }, (_, i) => i) : [bandIndex];
  const sectorAngle = 360 / SECTOR_COUNT;
  return Array.from({ length: SECTOR_COUNT }, (_, secIdx) => {
    const merged = mergeTopK(bandIndexes.map((b) => cells[b][secIdx]));
    return { bearingDeg: (secIdx + 0.5) * sectorAngle, ...statsFromTopK(merged) };
  });
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
  setConfigJSON(CONFIG_KEY, { cells });
  dirty = false;
  return true;
}

export function resetAntennaStats() {
  cells = createEmptyCells();
  latestSignalDbfs = null;
  latestPeakSignalDbfs = null;
  loaded = false;
  dirty = false;
}
