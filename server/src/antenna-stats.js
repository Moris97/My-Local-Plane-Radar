import { distanceKm, bearingDegrees, roundKm } from './range.js';
import { getConfigJSON, setConfigJSON, deleteConfig } from './db.js';

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

// 2° per sector (raised from 120 sectors/3° -- see CLAUDE.md for the two
// earlier bumps, 16->72->120 -- after confirming again, 2026-08-02, that
// storage/CPU/network cost of going finer stays trivial at any resolution:
// BAND_SLOTS * SECTOR_COUNT * TOP_K is still only 9,000 floats at 180
// sectors (was 6,000 at 120), and the coverage endpoint's two GeoJSON
// rings grow from ~242 to ~362 points -- a few KB either way. At a strong
// receiver's realistic max range (roughly 300-400 km), one sector now
// "speaks for" ~10-14 km of arc (was ~15-21 km at 120). The real limit
// going finer is statistical, not architectural: each (band, sector)
// cell accumulates fewer real contacts the finer sectors get, so a single-
// band map view can stay sparse for a while on a new install (though the
// "all altitudes" view, which merges across all 10 band slots per sector,
// stays well-populated much sooner). That tradeoff self-corrects as more
// data accumulates over weeks/months; it doesn't get worse over time the
// way it would if this were unbounded storage. Easy constant to retune
// again later; nothing else hardcodes this number.
export const SECTOR_COUNT = 180;

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

// A position is only trusted for antenna coverage once its aircraft has
// actually been decoded a few times. Samples used to be recorded once per
// second per tracked aircraft with no floor on this at all -- combined with
// TOP_K not being deduped by aircraft (see below), the retained "best 5" in
// a cell were usually 5 consecutive seconds of one plane, measured live as
// topAvgRangeKm == maxRangeKm in 169 of 180 sectors: the outlier resistance
// this whole mechanism exists for didn't actually exist. `messages` is
// readsb's own cumulative per-aircraft counter (the "Messages received"
// tile in the details panel) -- reading it directly off decode volume,
// rather than off elapsed polling time, means a single lucky decode from a
// distant aircraft (a bit-error near-miss that happened to validate, or a
// contact glimpsed for only a couple of frames before fading) can no longer
// set a "best-ever" figure on its own. 4 is deliberately low: a global CPR
// position decode needs at least two position frames, so this asks for
// barely more than "seen more than once", not for a sustained contact --
// the whole point of a range figure is to capture genuinely marginal
// reception, just not a single fluke.
const MIN_MESSAGES_FOR_SAMPLE = 4;

export function isAntennaSampleEligible(messages) {
  return typeof messages === 'number' && messages >= MIN_MESSAGES_FOR_SAMPLE;
}

function createEmptyCells() {
  return Array.from({ length: BAND_SLOTS }, () => Array.from({ length: SECTOR_COUNT }, () => []));
}

let cells = createEmptyCells();
let latestSignalDbfs = null;
let latestPeakSignalDbfs = null;
let loaded = false;
let dirty = false;

// Bumped on every genuine content change (a sample that actually improved
// a cell, or a manual clear) -- lets the client poll a cheap `{ revision }`
// endpoint every second or two to watch the coverage map build up live,
// without recomputing/re-fetching/re-uploading the whole polygon to the
// GPU on every tick regardless of whether anything changed. Independent of
// `dirty`: that flag drives the SD-card flush cadence (minutes) and is
// cleared after each write, while this is purely an in-memory "has
// anything happened since the client last looked" counter and never
// resets on its own. The client compares with `!==`, not `>`, so a server
// restart (revision resets to 0) is still detected as "different" and
// triggers a catch-up fetch, rather than looking frozen at a now-stale
// higher number forever.
let revision = 0;

export function getAntennaStatsRevision() {
  return revision;
}

// Persisted as compact [km, hex] tuples rather than {km, hex} objects --
// repeated JSON field names were most of the weight of a similar blob
// elsewhere in this app (stats-history.js's snapshot), and at up to
// BAND_SLOTS * SECTOR_COUNT * TOP_K = 9,000 entries here, the same waste
// would apply. In-memory shape stays {km, hex} objects, which read better
// than index-juggling a tuple through insertIntoTopK/mergeTopK.
function serializeCells() {
  return cells.map((band) => band.map((cell) => cell.map((e) => [e.km, e.hex])));
}

function ensureLoaded() {
  if (loaded) return;
  loaded = true;
  const stored = getConfigJSON(CONFIG_KEY, null);
  // Checked all the way down to each entry, not just the outer band/sector
  // shape: a blob from before hex-deduping (this file's own earlier
  // format) has the same BAND_SLOTS x SECTOR_COUNT shape but plain-number
  // leaves, which would otherwise pass the outer check and then be
  // misread as tuples (`v[0]`/`v[1]` on a number). There is no way to
  // recover which aircraft contributed each historical number, so -- same
  // as the redesign before this one -- a shape that doesn't match is
  // ignored and started fresh rather than migrated.
  const validShape =
    Array.isArray(stored?.cells) &&
    stored.cells.length === BAND_SLOTS &&
    stored.cells.every(
      (band) =>
        Array.isArray(band) &&
        band.length === SECTOR_COUNT &&
        band.every(
          (cell) =>
            Array.isArray(cell) &&
            cell.every((e) => Array.isArray(e) && e.length === 2 && typeof e[0] === 'number' && typeof e[1] === 'string'),
        ),
    );
  if (validShape) {
    cells = stored.cells.map((band) => band.map((cell) => cell.map(([km, hex]) => ({ km, hex }))));
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

// Keeps `list` (entries of {km, hex}) sorted descending by km, capped at
// TOP_K, with **at most one entry per hex** -- the actual fix for the
// degeneracy above. Per-second polling means the same aircraft is offered
// to the same cell dozens of times while it sits in one sector at one
// altitude; without this, its own consecutive samples simply filled up the
// "best 5" by themselves. A hex already present is updated in place only
// if it improved (this is "best ever per aircraft", not "most recent"), so
// a later, closer position from the same plane can't push its own earlier
// achievement back out. Returns true if anything actually changed, for the
// dirty flag.
function insertIntoTopK(list, hex, km) {
  const existingIdx = list.findIndex((e) => e.hex === hex);
  if (existingIdx !== -1) {
    if (km <= list[existingIdx].km) return false;
    list[existingIdx] = { km, hex };
    list.sort((a, b) => b.km - a.km);
    return true;
  }
  if (list.length < TOP_K) {
    list.push({ km, hex });
    list.sort((a, b) => b.km - a.km);
    return true;
  }
  if (km <= list[list.length - 1].km) return false;
  list[list.length - 1] = { km, hex };
  list.sort((a, b) => b.km - a.km);
  return true;
}

// Called once per poll tick per tracked aircraft with a known position
// (same "every tracked aircraft, not just the delta" reasoning as
// index.js's other per-tick sightings -- see recordRangeAndRegistrationSightings).
// A no-op below the message-count floor (isAntennaSampleEligible) -- the
// caller doesn't have to remember to gate this itself.
export function recordAntennaSample({ homeLat, homeLon, lat, lon, altBaro, onGround, hex, messages }) {
  if (!isAntennaSampleEligible(messages)) return;
  ensureLoaded();

  // Rounded to 10 m before it is ever stored. The whole cells structure is
  // persisted as one JSON config blob, and at full double precision the
  // digits *are* the blob -- 17 characters per number where three decimals
  // is already metre-level, on a figure only ever drawn as "434 km". Also
  // damps the dirty flag: a sample that rounds to a value already held no
  // longer counts as an improvement worth rewriting the blob for.
  const km = roundKm(distanceKm(homeLat, homeLon, lat, lon));
  const bandIdx = altitudeBandIndex(altBaro, onGround);
  const slot = bandIdx === -1 ? UNKNOWN_BAND_SLOT : bandIdx;
  const secIdx = sectorIndex(bearingDegrees(homeLat, homeLon, lat, lon));

  if (insertIntoTopK(cells[slot][secIdx], hex, km)) {
    dirty = true;
    revision += 1;
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

// Combines several cells' top-K lists into one (e.g. every sector for one
// altitude band, or every band for one sector) -- still deduped by hex
// across the *whole* merge, not just within each source cell: an aircraft
// climbing through a sector can be its own best-ever contact in more than
// one altitude band's cell for that same sector, and without this it would
// occupy more than one of the merged result's TOP_K slots. Returns plain
// km numbers (statsFromTopK below doesn't need to know about hex at all).
function mergeTopK(lists) {
  const bestPerHex = new Map();
  for (const entry of lists.flat()) {
    const current = bestPerHex.get(entry.hex);
    if (current === undefined || entry.km > current) bestPerHex.set(entry.hex, entry.km);
  }
  return [...bestPerHex.values()].sort((a, b) => b - a).slice(0, TOP_K);
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
  setConfigJSON(CONFIG_KEY, { cells: serializeCells() });
  dirty = false;
  return true;
}

// Throws away every recorded band/sector sample, on disk as well as in
// memory. Distinct from resetAntennaStats() below, which only drops the
// in-memory state (tests) and would happily reload the same blob from
// SQLite on the next read. The reason this exists at all: every stored
// sample is a distance and a bearing *relative to the home location it was
// recorded against*, so moving the receiver silently invalidates all of
// it -- there was no way to say so and start over.
export function clearAntennaStats() {
  cells = createEmptyCells();
  loaded = true;
  dirty = false;
  revision += 1; // the client's cached shape is now stale too, same as a real sample arriving
  deleteConfig(CONFIG_KEY);
}

// Forgets the in-memory cells so the next read re-reads the stored blob --
// used after a backup restore has replaced that blob underneath us.
//
// Deliberately neither of its two neighbours. clearAntennaStats() would
// deleteConfig() the key we just imported. resetAntennaStats() zeroes
// `revision`, which app.js compares with !== against its own cached number
// specifically so a server restart still reads as "changed" -- winding it
// back to 0 here would leave a browser that last saw 0 convinced its
// coverage polygon was already up to date. It also drops the latest signal
// readings, which are live receiver measurements with nothing to do with an
// import.
export function reloadAntennaStatsFromDb() {
  cells = createEmptyCells();
  loaded = false;
  dirty = false;
  revision += 1;
}

export function resetAntennaStats() {
  cells = createEmptyCells();
  latestSignalDbfs = null;
  latestPeakSignalDbfs = null;
  loaded = false;
  dirty = false;
  revision = 0;
}
