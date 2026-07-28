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
  recordAntennaSample,
  recordSignalReading,
  getAltitudeBandStats,
  getSectorStats,
  getLatestSignal,
  flushAntennaStatsIfDirty,
  resetAntennaStats,
} = await import('./antenna-stats.js');

after(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  resetAntennaStats();
});

const HOME = { homeLat: 50.0, homeLon: 20.0 };

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
  recordAntennaSample({ ...HOME, lat: 51.0, lon: 20.0, altBaro: 3000, onGround: false });
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
  recordAntennaSample({ ...HOME, lat: 51.0, lon: 20.0, altBaro: 3000, onGround: false }); // far
  const farKm = getAltitudeBandStats()[0].maxRangeKm;

  recordAntennaSample({ ...HOME, lat: 50.1, lon: 20.0, altBaro: 3000, onGround: false }); // closer
  assert.equal(getAltitudeBandStats()[0].maxRangeKm, farKm);
});

test('a sample with no altitude data updates the sector but not any named altitude band', () => {
  recordAntennaSample({ ...HOME, lat: 51.0, lon: 20.0, altBaro: undefined, onGround: false });
  const bands = getAltitudeBandStats();
  assert.ok(bands.every((b) => b.maxRangeKm === 0));
  // Still counted in the "all bands" sector merge (bandIndex = null).
  assert.ok(getSectorStats()[0].maxRangeKm > 0);
});

test('getSectorStats(bandIndex) restricts to just that band, excluding samples from other bands', () => {
  recordAntennaSample({ ...HOME, lat: 51.0, lon: 20.0, altBaro: 3000, onGround: false }); // band 0
  recordAntennaSample({ ...HOME, lat: 51.5, lon: 20.0, altBaro: 12000, onGround: false }); // band 2, farther

  const band0Sectors = getSectorStats(0);
  const band2Sectors = getSectorStats(2);
  assert.ok(band0Sectors[0].maxRangeKm > 0);
  assert.equal(band2Sectors[0].maxRangeKm > band0Sectors[0].maxRangeKm, true);

  // A band with nothing recorded reports zeros, not a crash.
  const band5Sectors = getSectorStats(5);
  assert.ok(band5Sectors.every((s) => s.maxRangeKm === 0));
});

test('topAvgRangeKm smooths a single outlier sample instead of being dragged all the way to it', () => {
  // Five realistic ~100km samples, then one wild 500km outlier (e.g. a
  // stray MLAT glitch). A single running max would jump straight to 500;
  // the top-5 average should land well below it.
  for (let i = 0; i < 5; i++) {
    recordAntennaSample({ ...HOME, lat: 50.9 + i * 0.01, lon: 20.0, altBaro: 3000, onGround: false });
  }
  recordAntennaSample({ ...HOME, lat: 54.5, lon: 20.0, altBaro: 3000, onGround: false }); // far outlier

  const band = getAltitudeBandStats()[0];
  assert.ok(band.maxRangeKm > 400, `expected the max to reflect the outlier, got ${band.maxRangeKm}`);
  assert.ok(
    band.topAvgRangeKm < band.maxRangeKm * 0.7,
    `expected the top-5 average (${band.topAvgRangeKm}) to be pulled down well below the max (${band.maxRangeKm})`,
  );
});

test('the retained top-K set only grows to accept genuinely better samples, capped at a fixed size', () => {
  // Record more samples than TOP_K (5) -- only the best 5 should survive,
  // proven by checking the average moves up as better samples arrive but
  // eventually stabilizes rather than being dragged down by older, worse
  // ones that should have been evicted.
  const sameSpotKm = (offset) => ({ ...HOME, lat: 50.0 + offset, lon: 20.0, altBaro: 3000, onGround: false });
  for (let i = 1; i <= 5; i++) recordAntennaSample(sameSpotKm(i * 0.01)); // five small, increasing samples
  const afterFive = getAltitudeBandStats()[0].topAvgRangeKm;

  for (let i = 0; i < 20; i++) recordAntennaSample(sameSpotKm(0.001)); // twenty tiny, much smaller samples
  const afterTwentyTiny = getAltitudeBandStats()[0].topAvgRangeKm;

  // The tiny samples never beat the retained top 5, so the average is unchanged.
  assert.equal(afterTwentyTiny, afterFive);
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
  recordAntennaSample({ ...HOME, lat: 51.0, lon: 20.0, altBaro: 3000, onGround: false });
  assert.equal(flushAntennaStatsIfDirty(), true);
  // Nothing changed since the last flush -- no-op.
  assert.equal(flushAntennaStatsIfDirty(), false);
});

test('a sample too small to enter an already-full top-K does not mark the state dirty', () => {
  const sameSpotKm = (offset) => ({ ...HOME, lat: 50.0 + offset, lon: 20.0, altBaro: 3000, onGround: false });
  for (let i = 1; i <= 5; i++) recordAntennaSample(sameSpotKm(i * 0.1));
  flushAntennaStatsIfDirty();

  recordAntennaSample(sameSpotKm(0.0001)); // much smaller than all 5 retained samples
  assert.equal(flushAntennaStatsIfDirty(), false);
});

test('stats survive a reload from persisted config (simulating a restart)', () => {
  recordAntennaSample({ ...HOME, lat: 51.0, lon: 20.0, altBaro: 3000, onGround: false });
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
