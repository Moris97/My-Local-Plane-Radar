import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = mkdtempSync(join(tmpdir(), 'mlpr-antenna-stats-test-'));
process.env.MLPR_DB_PATH = join(tmpDir, 'test.db');

const {
  ALTITUDE_BANDS,
  SECTOR_COUNT,
  altitudeBandIndex,
  sectorIndex,
  isAntennaSampleEligible,
  recordAntennaSample,
  recordSignalReading,
  getAltitudeBandStats,
  getSectorStats,
  getLatestSignal,
  flushAntennaStatsIfDirty,
  clearAntennaStats,
  resetAntennaStats,
  getAntennaStatsRevision,
} = await import('./antenna-stats.js');

after(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  resetAntennaStats();
});

const HOME = { homeLat: 50.0, homeLon: 20.0 };

// A distinct hex per call, for tests that mean to simulate several
// different aircraft -- top-K is deduped by hex now, so reusing one hex
// (or leaving it undefined) across calls would collapse them into a single
// updated-in-place entry instead of populating several distinct slots.
let nextHexId = 0;
function hex() {
  nextHexId += 1;
  return `HEX${String(nextHexId).padStart(4, '0')}`;
}

// messages defaults comfortably above the eligibility floor -- tests
// specifically about that floor override it explicitly.
function sample(overrides) {
  return { ...HOME, hex: hex(), messages: 10, altBaro: 3000, onGround: false, ...overrides };
}

// Every stored sample is a distance and a bearing relative to the home
// location it was recorded against, so moving the receiver invalidates all
// of it at once. resetAntennaStats() alone isn't enough: it only drops the
// in-memory copy, which the next read would reload straight back out of
// SQLite.
test('clearAntennaStats wipes the recorded cells, and they stay gone after a reload', () => {
  recordAntennaSample(sample({ lat: 51.0, lon: 20.0, altBaro: 30000 }));
  flushAntennaStatsIfDirty();
  assert.ok(getSectorStats().some((s) => s.maxRangeKm > 0), 'sanity check: something was recorded');

  clearAntennaStats();
  assert.equal(getSectorStats().every((s) => s.maxRangeKm === 0), true);

  resetAntennaStats(); // forces the next read to go back to SQLite
  assert.equal(getSectorStats().every((s) => s.maxRangeKm === 0), true);
});

// The cells structure is persisted verbatim as one JSON config blob, and at
// full double precision the digits are the overwhelming majority of it --
// a real, repeated SD write cost. 10 m is already far finer than anything
// this figure is ever drawn or compared at.
test('recorded distances are rounded to 10 m before they are ever stored', () => {
  recordAntennaSample(sample({ lat: 50.4321987654321, lon: 20.7654321987654, altBaro: 30000 }));

  const [sector] = getSectorStats().filter((s) => s.maxRangeKm > 0);
  assert.notEqual(sector, undefined, 'sanity check: the sample was recorded at all');
  assert.equal(sector.maxRangeKm, Math.round(sector.maxRangeKm * 100) / 100);
  assert.ok(String(sector.maxRangeKm).length <= 7, `expected a short number, got ${sector.maxRangeKm}`);
});

test('altitudeBandIndex buckets a flying aircraft into the band its altitude falls under', () => {
  assert.equal(altitudeBandIndex(1000, false), 0);
  assert.equal(altitudeBandIndex(4999, false), 0);
  assert.equal(altitudeBandIndex(5000, false), 1);
  assert.equal(altitudeBandIndex(39999, false), 7);
  assert.equal(altitudeBandIndex(45000, false), 8);
});

test('altitudeBandIndex treats onGround as altitude 0, regardless of altBaro', () => {
  assert.equal(altitudeBandIndex(30000, true), 0);
});

test('altitudeBandIndex returns -1 when altitude data is missing', () => {
  assert.equal(altitudeBandIndex(undefined, false), -1);
  assert.equal(altitudeBandIndex(null, false), -1);
});

test('sectorIndex maps 0-360 degrees onto SECTOR_COUNT sectors, wrapping at 360', () => {
  assert.equal(sectorIndex(0), 0);
  assert.equal(sectorIndex(90), Math.floor(SECTOR_COUNT / 4));
  assert.equal(sectorIndex(180), Math.floor(SECTOR_COUNT / 2));
  assert.equal(sectorIndex(270), Math.floor((3 * SECTOR_COUNT) / 4));
  assert.equal(sectorIndex(359.999), SECTOR_COUNT - 1);
  assert.equal(sectorIndex(360), 0);
});

test('recordAntennaSample updates the altitude band and sector that a sample falls into', () => {
  // Due north (bearing 0 -> sector 0), ~111 km away, 3000 ft (band 0).
  recordAntennaSample(sample({ lat: 51.0, lon: 20.0 }));
  const bands = getAltitudeBandStats();
  const sectors = getSectorStats();
  assert.ok(bands[0].maxRangeKm > 0);
  assert.ok(sectors[0].maxRangeKm > 0);
  assert.equal(bands.length, ALTITUDE_BANDS.length);
  assert.equal(sectors.length, SECTOR_COUNT);
});

test('getSectorStats reports a bearing at the midpoint of each sector', () => {
  const sectors = getSectorStats();
  const sectorAngle = 360 / SECTOR_COUNT;
  assert.equal(sectors[0].bearingDeg, sectorAngle / 2);
  assert.equal(sectors[1].bearingDeg, sectorAngle + sectorAngle / 2);
});

test('recordAntennaSample keeps the maximum range seen per band/sector, never shrinks it', () => {
  // Same hex both times -- one aircraft, first caught far out, later flying
  // closer. Its own earlier achievement must stick either way: a same-hex
  // update only replaces the retained value when the new one is better
  // (see insertIntoTopK), and a worse different-hex sample could only ever
  // evict a *worse* existing entry, never this one.
  const plane = hex();
  recordAntennaSample(sample({ hex: plane, lat: 51.0, lon: 20.0 })); // far
  const farKm = getAltitudeBandStats()[0].maxRangeKm;

  recordAntennaSample(sample({ hex: plane, lat: 50.1, lon: 20.0 })); // closer
  assert.equal(getAltitudeBandStats()[0].maxRangeKm, farKm);
});

test('a sample with no altitude data updates the sector but not any named altitude band', () => {
  recordAntennaSample(sample({ lat: 51.0, lon: 20.0, altBaro: undefined }));
  const bands = getAltitudeBandStats();
  assert.ok(bands.every((b) => b.maxRangeKm === 0));
  // Still counted in the "all bands" sector merge (bandIndex = null).
  assert.ok(getSectorStats()[0].maxRangeKm > 0);
});

test('getSectorStats(bandIndex) restricts to just that band, excluding samples from other bands', () => {
  recordAntennaSample(sample({ lat: 51.0, lon: 20.0, altBaro: 3000 })); // band 0
  recordAntennaSample(sample({ lat: 51.5, lon: 20.0, altBaro: 12000 })); // band 2, farther

  const band0Sectors = getSectorStats(0);
  const band2Sectors = getSectorStats(2);
  assert.ok(band0Sectors[0].maxRangeKm > 0);
  assert.equal(band2Sectors[0].maxRangeKm > band0Sectors[0].maxRangeKm, true);

  // A band with nothing recorded reports zeros, not a crash.
  const band5Sectors = getSectorStats(5);
  assert.ok(band5Sectors.every((s) => s.maxRangeKm === 0));
});

test('topAvgRangeKm smooths a single outlier sample instead of being dragged all the way to it', () => {
  // Five realistic ~100km samples from five distinct aircraft, then one
  // wild 500km outlier from a sixth (e.g. a stray MLAT glitch). A single
  // running max would jump straight to 500; the top-5 average should land
  // well below it. Distinct hexes throughout -- top-K is deduped by
  // aircraft, so this is exactly the scenario that degenerated before that
  // fix (five same-plane samples couldn't out-vote one real outlier).
  for (let i = 0; i < 5; i++) {
    recordAntennaSample(sample({ lat: 50.9 + i * 0.01, lon: 20.0 }));
  }
  recordAntennaSample(sample({ lat: 54.5, lon: 20.0 })); // far outlier, distinct aircraft

  const band = getAltitudeBandStats()[0];
  assert.ok(band.maxRangeKm > 400, `expected the max to reflect the outlier, got ${band.maxRangeKm}`);
  assert.ok(
    band.topAvgRangeKm < band.maxRangeKm * 0.7,
    `expected the top-5 average (${band.topAvgRangeKm}) to be pulled down well below the max (${band.maxRangeKm})`,
  );
});

// The bug this whole redesign fixed: per-second polling used to offer the
// SAME aircraft to a cell over and over while it sat in one sector at one
// altitude, so a cell's "best 5" were usually 5 consecutive seconds of one
// plane -- measured live, topAvgRangeKm equalled maxRangeKm in 169 of 180
// sectors, i.e. no outlier resistance at all. Deduping by hex is the fix:
// repeated samples from one aircraft can only ever occupy one slot.
test('repeated samples from the same aircraft only ever occupy one top-K slot', () => {
  const plane = hex();
  for (let i = 0; i < 20; i++) {
    // Slowly improving, as if cruising steadily closer to the edge of range.
    recordAntennaSample(sample({ hex: plane, lat: 50.9 + i * 0.001, lon: 20.0 }));
  }
  const band = getAltitudeBandStats()[0];
  // With only one distinct aircraft ever recorded, max and top-avg are
  // necessarily the same number -- correctly so, this time, because there
  // is genuinely only one sample to average, not because five consecutive
  // seconds of it masqueraded as five.
  assert.equal(band.maxRangeKm, band.topAvgRangeKm);
});

test('five distinct aircraft at similar range are not collapsed into one, unlike five seconds of the same one', () => {
  for (let i = 0; i < 5; i++) {
    recordAntennaSample(sample({ lat: 50.9 + i * 0.001, lon: 20.0 })); // five aircraft, five distinct hexes
  }
  const band = getAltitudeBandStats()[0];
  // Genuinely different aircraft at genuinely different distances -- top
  // and average should differ, the opposite of the degenerate case above.
  assert.notEqual(band.maxRangeKm, band.topAvgRangeKm);
});

// getAltitudeBandStats merges every sector's top-K for one band; an
// aircraft that was the best-ever contact recorded in two different
// sectors of that band (e.g. it happened to be the top-5 in both, at
// different points along its route) must still only be counted once in
// the merged result -- mergeTopK dedupes across the whole merge, not just
// within each source cell.
test('the same aircraft best-in two different sectors of one band is only counted once in the band merge', () => {
  const plane = hex();
  recordAntennaSample(sample({ hex: plane, lat: 51.0, lon: 20.0 })); // sector near bearing 0
  recordAntennaSample(sample({ hex: plane, lat: 50.5, lon: 20.9 })); // a different sector, better distance

  const others = getAltitudeBandStats()[0];
  assert.equal(others.maxRangeKm, others.topAvgRangeKm, 'only one distinct aircraft was ever recorded in this band');
});

test('getSectorStats(null) merges across altitude bands with the same per-hex dedup', () => {
  const plane = hex();
  recordAntennaSample(sample({ hex: plane, lat: 51.0, lon: 20.0, altBaro: 3000 })); // band 0
  recordAntennaSample(sample({ hex: plane, lat: 51.0, lon: 20.0, altBaro: 12000 })); // band 2, same bearing, farther

  const allBands = getSectorStats()[0];
  assert.equal(allBands.maxRangeKm, allBands.topAvgRangeKm, 'still only one distinct aircraft across every band');
});

test('isAntennaSampleEligible requires a minimum number of decoded messages', () => {
  assert.equal(isAntennaSampleEligible(0), false);
  assert.equal(isAntennaSampleEligible(1), false);
  assert.equal(isAntennaSampleEligible(3), false);
  assert.equal(isAntennaSampleEligible(4), true);
  assert.equal(isAntennaSampleEligible(500), true);
  assert.equal(isAntennaSampleEligible(undefined), false);
  assert.equal(isAntennaSampleEligible(null), false);
});

// This is the actual defence against a single lucky decode setting a
// "best-ever" figure: a contact glimpsed for only a couple of frames
// before fading (a bit-error near-miss that happened to validate a
// position, or a genuine but fleeting catch) never gets to enter the top-K
// at all, regardless of how impressive its one-off distance looks.
test('recordAntennaSample below the message-count floor is a complete no-op', () => {
  recordAntennaSample(sample({ lat: 51.0, lon: 20.0, messages: 1 }));
  assert.equal(getSectorStats().every((s) => s.maxRangeKm === 0), true);
  assert.equal(flushAntennaStatsIfDirty(), false);
});

test('recordAntennaSample with a missing messages count is a no-op, same as too few', () => {
  recordAntennaSample(sample({ lat: 51.0, lon: 20.0, messages: undefined }));
  assert.equal(getSectorStats().every((s) => s.maxRangeKm === 0), true);
});

test('recordAntennaSample at exactly the message-count floor is recorded', () => {
  recordAntennaSample(sample({ lat: 51.0, lon: 20.0, messages: 4 }));
  assert.equal(getSectorStats().some((s) => s.maxRangeKm > 0), true);
});

test('the retained top-K set only grows to accept genuinely better samples, capped at a fixed size', () => {
  // Record more samples than TOP_K (5), each a distinct aircraft -- only
  // the best 5 should survive, proven by checking the average moves up as
  // better samples arrive but eventually stabilizes rather than being
  // dragged down by later, worse ones that should have been evicted.
  const atOffset = (offset) => sample({ lat: 50.0 + offset, lon: 20.0 });
  for (let i = 1; i <= 5; i++) recordAntennaSample(atOffset(i * 0.01)); // five small, increasing samples
  const afterFive = getAltitudeBandStats()[0].topAvgRangeKm;

  for (let i = 0; i < 20; i++) recordAntennaSample(atOffset(0.001)); // twenty tiny, much smaller, from 20 more distinct aircraft
  const afterTwentyTiny = getAltitudeBandStats()[0].topAvgRangeKm;

  // The tiny samples never beat the retained top 5, so the average is unchanged.
  assert.equal(afterTwentyTiny, afterFive);
});

// Lets the client poll a bare integer every couple of seconds instead of
// re-fetching/re-rendering the whole coverage polygon on a timer
// regardless of whether anything changed.
test('the revision counter only advances on a genuine change', () => {
  assert.equal(getAntennaStatsRevision(), 0);

  const firstPlane = hex();
  recordAntennaSample(sample({ hex: firstPlane, lat: 51.0, lon: 20.0 }));
  assert.equal(getAntennaStatsRevision(), 1);

  // Same hex, same (or worse) distance -- insertIntoTopK is a no-op, so
  // this must not look like a change either.
  recordAntennaSample(sample({ hex: firstPlane, lat: 50.5, lon: 20.0 }));
  assert.equal(getAntennaStatsRevision(), 1);

  // Below the message-count floor -- never reaches insertIntoTopK at all.
  recordAntennaSample(sample({ lat: 52.0, lon: 20.0, messages: 1 }));
  assert.equal(getAntennaStatsRevision(), 1);

  // A genuinely new, distinct aircraft -- a real change.
  recordAntennaSample(sample({ lat: 51.0, lon: 25.0 }));
  assert.equal(getAntennaStatsRevision(), 2);
});

test('clearAntennaStats bumps the revision too -- the client\'s cached shape is now stale', () => {
  recordAntennaSample(sample({ lat: 51.0, lon: 20.0 }));
  const before = getAntennaStatsRevision();

  clearAntennaStats();

  assert.notEqual(getAntennaStatsRevision(), before);
});

test('recordSignalReading tracks the latest signal reading, overwriting on each call', () => {
  recordSignalReading(-12.5, -3.1);
  assert.deepEqual(getLatestSignal(), { signalDbfs: -12.5, peakSignalDbfs: -3.1 });

  recordSignalReading(-8.0, -1.0);
  assert.deepEqual(getLatestSignal(), { signalDbfs: -8.0, peakSignalDbfs: -1.0 });
});

test('recordSignalReading ignores non-number values instead of overwriting with garbage', () => {
  recordSignalReading(-12.5, -3.1);
  recordSignalReading(undefined, undefined);
  assert.deepEqual(getLatestSignal(), { signalDbfs: -12.5, peakSignalDbfs: -3.1 });
});

test('flushAntennaStatsIfDirty only writes (and returns true) when something changed', () => {
  assert.equal(flushAntennaStatsIfDirty(), false);
  recordAntennaSample(sample({ lat: 51.0, lon: 20.0 }));
  assert.equal(flushAntennaStatsIfDirty(), true);
  // Nothing changed since the last flush -- no-op.
  assert.equal(flushAntennaStatsIfDirty(), false);
});

test('a sample too small to enter an already-full top-K does not mark the state dirty', () => {
  const atOffset = (offset) => sample({ lat: 50.0 + offset, lon: 20.0 });
  for (let i = 1; i <= 5; i++) recordAntennaSample(atOffset(i * 0.1));
  flushAntennaStatsIfDirty();

  recordAntennaSample(atOffset(0.0001)); // a sixth, distinct aircraft, much closer than all 5 retained
  assert.equal(flushAntennaStatsIfDirty(), false);
});

// The same aircraft reporting a worse position than its own already-
// retained best is exactly as much a no-op as a different, worse aircraft
// -- covered separately because insertIntoTopK takes a different branch
// for an existing hex (update-in-place) than for a new one (evict-worst).
test('a same-hex sample that does not improve on its own retained value does not mark the state dirty', () => {
  const plane = hex();
  recordAntennaSample(sample({ hex: plane, lat: 51.0, lon: 20.0 })); // far
  flushAntennaStatsIfDirty();

  recordAntennaSample(sample({ hex: plane, lat: 50.1, lon: 20.0 })); // same plane, closer
  assert.equal(flushAntennaStatsIfDirty(), false);
});

test('stats survive a reload from persisted config (simulating a restart)', () => {
  recordAntennaSample(sample({ lat: 51.0, lon: 20.0 }));
  flushAntennaStatsIfDirty();
  const before = getAltitudeBandStats()[0];

  resetAntennaStats();
  const after = getAltitudeBandStats()[0];
  assert.deepEqual(after, before);
});

test('a mismatched stored shape (e.g. from before this data model) is ignored, starting fresh instead of crashing', async () => {
  // Simulate an old persisted blob shaped like the pre-redesign version.
  resetAntennaStats();
  const dbModule = await import('./db.js');
  dbModule.setConfigJSON('antennaStats', { altitudeBandMaxKm: [1, 2, 3], sectorMaxKm: [1, 2, 3] });
  resetAntennaStats();

  assert.doesNotThrow(() => getAltitudeBandStats());
  assert.ok(getAltitudeBandStats().every((b) => b.maxRangeKm === 0));
});

// A different mismatch: the outer band/sector shape is right (this WAS a
// valid antennaStats blob), but each cell's entries are plain numbers --
// exactly what this file wrote before hex-dedup existed. There is no way
// to recover which aircraft contributed each historical number, so this
// is ignored and started fresh too, not migrated -- same as the redesign
// before this one.
test('a pre-hex-dedup stored shape (plain-number cells) is ignored, starting fresh', async () => {
  resetAntennaStats();
  const dbModule = await import('./db.js');
  const bandSlots = ALTITUDE_BANDS.length + 1; // +1 for the internal unknown-altitude slot
  const oldShapeCells = Array.from({ length: bandSlots }, () =>
    Array.from({ length: SECTOR_COUNT }, () => [100, 90, 80]),
  );
  dbModule.setConfigJSON('antennaStats', { cells: oldShapeCells });
  resetAntennaStats();

  assert.doesNotThrow(() => getAltitudeBandStats());
  assert.ok(getAltitudeBandStats().every((b) => b.maxRangeKm === 0));
});
