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
  SECTOR_LABELS,
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

test('sectorIndex maps 0-360 degrees onto 16 sectors, wrapping at 360', () => {
  assert.equal(sectorIndex(0), 0); // N
  assert.equal(sectorIndex(90), 4); // E
  assert.equal(sectorIndex(180), 8); // S
  assert.equal(sectorIndex(270), 12); // W
  assert.equal(sectorIndex(359.9), 15); // NNW, not wrapping to 0
  assert.equal(sectorIndex(360), 0);
});

test('recordAntennaSample updates the altitude band and sector that a sample falls into', () => {
  // Due north (bearing 0 -> sector 0 "N"), ~111 km away, 3000 ft (band 0).
  recordAntennaSample({ ...HOME, lat: 51.0, lon: 20.0, altBaro: 3000, onGround: false });
  const bands = getAltitudeBandStats();
  const sectors = getSectorStats();
  assert.ok(bands[0].maxRangeKm > 0);
  assert.ok(sectors[0].maxRangeKm > 0);
  assert.equal(bands.length, ALTITUDE_BANDS.length);
  assert.equal(sectors.length, SECTOR_COUNT);
  assert.equal(sectors[0].label, SECTOR_LABELS[0]);
});

test('recordAntennaSample only keeps the maximum range seen per band/sector, never shrinks it', () => {
  recordAntennaSample({ ...HOME, lat: 51.0, lon: 20.0, altBaro: 3000, onGround: false }); // far
  const farKm = getAltitudeBandStats()[0].maxRangeKm;

  recordAntennaSample({ ...HOME, lat: 50.1, lon: 20.0, altBaro: 3000, onGround: false }); // closer
  assert.equal(getAltitudeBandStats()[0].maxRangeKm, farKm);
});

test('a sample with no altitude data updates the sector but not any altitude band', () => {
  recordAntennaSample({ ...HOME, lat: 51.0, lon: 20.0, altBaro: undefined, onGround: false });
  const bands = getAltitudeBandStats();
  assert.ok(bands.every((b) => b.maxRangeKm === 0));
  assert.ok(getSectorStats()[0].maxRangeKm > 0);
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

test('stats survive a reload from persisted config (simulating a restart)', async () => {
  recordAntennaSample({ ...HOME, lat: 51.0, lon: 20.0, altBaro: 3000, onGround: false });
  flushAntennaStatsIfDirty();
  const before = getAltitudeBandStats()[0].maxRangeKm;

  resetAntennaStats();
  const after = getAltitudeBandStats()[0].maxRangeKm;
  assert.equal(after, before);
});
