import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  ingestStats,
  getHistory,
  getDailyAccumulator,
  getLatestStatsValues,
  resetStatsHistory,
  recordRangeSample,
  getRangeSummary,
  getMaxRangeLastHourKm,
  getTodaysRangeSamples,
  recordDailyUnique,
  getDailyUniqueCounts,
  getTodayStartMs,
  snapshotForPersistence,
  restoreFromSnapshot,
} from './stats-history.js';

beforeEach(() => {
  resetStatsHistory();
});

function statsFixture(overrides = {}) {
  return {
    aircraft_with_pos: 3,
    aircraft_without_pos: 1,
    last1min: { end: 1700000000, messages: 300 },
    total: { max_distance: 200000 },
    ...overrides,
  };
}

test('ingesting without a last1min period is ignored', () => {
  assert.equal(ingestStats({}), null);
  assert.equal(getHistory().length, 0);
});

test('a valid stats snapshot produces one history sample', () => {
  const sample = ingestStats(statsFixture());
  assert.equal(sample.aircraftCount, 4);
  assert.equal(sample.withPos, 3);
  assert.equal(sample.withoutPos, 1);
  assert.equal(sample.messagesPerMinute, 300);
  assert.equal(sample.maxRangeKm, 200);
  assert.equal(getHistory().length, 1);
});

test('re-ingesting the same minute is a no-op', () => {
  ingestStats(statsFixture());
  const second = ingestStats(statsFixture());
  assert.equal(second, null);
  assert.equal(getHistory().length, 1);
});

test('a newer minute appends a new sample', () => {
  ingestStats(statsFixture());
  ingestStats(statsFixture({ last1min: { end: 1700000060, messages: 250 } }));
  assert.equal(getHistory().length, 2);
});

test('getLatestStatsValues reflects the most recent sample', () => {
  ingestStats(statsFixture({ last1min: { end: 1700000000, messages: 300 }, total: { max_distance: 200000 } }));
  ingestStats(statsFixture({ last1min: { end: 1700000060, messages: 600 }, total: { max_distance: 250000 } }));
  const values = getLatestStatsValues();
  assert.equal(values.messagesPerSec, 10);
  assert.equal(values.maxRangeKm, 250);
});

test('daily accumulator takes the max aircraft count and sums messages', () => {
  ingestStats(statsFixture({ aircraft_with_pos: 2, aircraft_without_pos: 0, last1min: { end: 1, messages: 100 } }));
  ingestStats(statsFixture({ aircraft_with_pos: 5, aircraft_without_pos: 0, last1min: { end: 2, messages: 150 } }));
  ingestStats(statsFixture({ aircraft_with_pos: 1, aircraft_without_pos: 0, last1min: { end: 3, messages: 50 } }));

  const acc = getDailyAccumulator();
  assert.equal(acc.maxAircraft, 5);
  assert.equal(acc.totalMessages, 300);
});

test('daily accumulator tracks sum/max separately for with-pos and without-pos, and a sample count for averaging', () => {
  ingestStats(statsFixture({ aircraft_with_pos: 2, aircraft_without_pos: 1, last1min: { end: 1, messages: 100 } }));
  ingestStats(statsFixture({ aircraft_with_pos: 6, aircraft_without_pos: 3, last1min: { end: 2, messages: 100 } }));

  const acc = getDailyAccumulator();
  assert.equal(acc.sampleCount, 2);
  assert.equal(acc.sumAircraft, 12); // (2+1) + (6+3)
  assert.equal(acc.sumWithPos, 8);
  assert.equal(acc.maxWithPos, 6);
  assert.equal(acc.sumWithoutPos, 4);
  assert.equal(acc.maxWithoutPos, 3);
});

test('history is capped so it cannot grow unbounded', () => {
  for (let i = 0; i < 1500; i += 1) {
    ingestStats(statsFixture({ last1min: { end: i, messages: 1 } }));
  }
  assert.equal(getHistory().length, 1440);
  assert.equal(getHistory()[0].t, 1500 - 1440);
});

const T0 = new Date('2026-03-01T00:00:00Z').getTime();
const MINUTE = 60000;

test('recordRangeSample keeps the best (max) reading within the same minute', () => {
  recordRangeSample(100, T0);
  recordRangeSample(250, T0 + 10000);
  recordRangeSample(180, T0 + 20000);
  assert.equal(getRangeSummary().maxRangeKm, 250);
});

test('getRangeSummary reflects the current in-progress minute immediately, not just rolled-over ones', () => {
  recordRangeSample(42, T0);
  assert.equal(getRangeSummary().maxRangeKm, 42);
});

test('a new minute rolls the previous minute\'s best into the samples used by getRangeSummary', () => {
  recordRangeSample(100, T0);
  recordRangeSample(50, T0 + MINUTE); // new minute -- 100 gets rolled in, 50 becomes current
  assert.equal(getRangeSummary().maxRangeKm, 100);
});

test('rangeTopAvgKm is the mean of the top ceil(10%) of per-minute best samples', () => {
  // 10 distinct per-minute bests: 10, 20, ..., 100 (9 rolled over during the
  // loop + the last one counted as the current in-progress minute -- see
  // the previous test). Top 10% of 10 samples is just 1 -- the highest.
  for (let i = 0; i < 10; i++) {
    recordRangeSample((i + 1) * 10, T0 + i * MINUTE);
  }
  assert.equal(getRangeSummary().rangeTopAvgKm, 100);
});

test('rangeTopAvgKm averages the top 2 of 20 samples when that is what ceil(10%) works out to', () => {
  for (let i = 0; i < 20; i++) {
    recordRangeSample(i + 1, T0 + i * MINUTE); // 1..20
  }
  assert.equal(getRangeSummary().rangeTopAvgKm, 19.5); // mean of 20 and 19
});

test('a day rollover (via ingestStats or recordRangeSample) resets the range samples', () => {
  recordRangeSample(500, T0);
  recordRangeSample(300, T0 + MINUTE);
  assert.equal(getRangeSummary().maxRangeKm, 500);

  const nextDay = T0 + 24 * 60 * MINUTE;
  recordRangeSample(10, nextDay);
  assert.equal(getRangeSummary().maxRangeKm, 10);
});

test('getRangeSummary is {0, 0} when nothing has been recorded yet', () => {
  const summary = getRangeSummary();
  assert.equal(summary.maxRangeKm, 0);
  assert.equal(summary.rangeTopAvgKm, 0);
});

test('getTodaysRangeSamples exposes each per-minute best reading with its minute-start timestamp', () => {
  recordRangeSample(100, T0);
  recordRangeSample(200, T0 + MINUTE);
  const samples = getTodaysRangeSamples();
  assert.deepEqual(samples, [
    { km: 100, t: T0 },
    { km: 200, t: T0 + MINUTE },
  ]);
});

test('a snapshot restored the same day brings back history, the accumulator, and range samples', () => {
  ingestStats(statsFixture({ aircraft_with_pos: 3, aircraft_without_pos: 1, last1min: { end: T0 / 1000, messages: 300 } }), T0);
  recordRangeSample(150, T0);
  recordRangeSample(300, T0 + MINUTE);

  const snapshot = snapshotForPersistence();
  resetStatsHistory();
  assert.equal(getHistory().length, 0, 'sanity check: reset actually cleared it');
  assert.equal(getRangeSummary().maxRangeKm, 0);

  // Restored "the same day" -- pass a `now` a few minutes after the
  // snapshot's own timestamp, still within the same calendar day.
  restoreFromSnapshot(snapshot, T0 + 5 * MINUTE);

  assert.equal(getHistory().length, 1);
  assert.equal(getDailyAccumulator().sampleCount, 1);
  assert.equal(getDailyAccumulator().maxAircraft, 4);
  assert.equal(getRangeSummary().maxRangeKm, 300);
});

test('a snapshot from a previous day is not restored -- today starts fresh instead of inheriting stale numbers', () => {
  ingestStats(statsFixture({ aircraft_with_pos: 9, last1min: { end: T0 / 1000, messages: 999 } }), T0);
  recordRangeSample(500, T0);
  const staleSnapshot = snapshotForPersistence();
  resetStatsHistory();

  const nextDay = T0 + 24 * 60 * MINUTE;
  restoreFromSnapshot(staleSnapshot, nextDay);

  assert.equal(getHistory().length, 0);
  assert.equal(getDailyAccumulator().sampleCount, 0);
  assert.equal(getRangeSummary().maxRangeKm, 0);
});

test('restoreFromSnapshot is a safe no-op when there is nothing stored yet (fresh install)', () => {
  restoreFromSnapshot(null, T0);
  assert.equal(getHistory().length, 0);
});

test('recordDailyUnique counts distinct hexes and flights, not raw calls', () => {
  recordDailyUnique('abc123', 'RYR4521');
  recordDailyUnique('abc123', 'RYR4521'); // same aircraft, same flight -- no change
  recordDailyUnique('def456', 'RYR4521'); // different aircraft, same flight number
  recordDailyUnique('ghi789', null); // no callsign yet -- counts the aircraft, not a flight

  const counts = getDailyUniqueCounts();
  assert.equal(counts.uniqueAircraftCount, 3);
  assert.equal(counts.uniqueFlightsCount, 1);
});

test('recordDailyUnique resets at day rollover, same as the rest of the daily accumulator', () => {
  recordDailyUnique('abc123', 'RYR4521', T0);
  assert.equal(getDailyUniqueCounts().uniqueAircraftCount, 1);

  recordDailyUnique('def456', 'WZZ7A', T0 + 24 * 60 * MINUTE);
  assert.equal(getDailyUniqueCounts().uniqueAircraftCount, 1);
});

test('a same-day snapshot restore brings back the daily unique counts', () => {
  recordDailyUnique('abc123', 'RYR4521', T0);
  recordDailyUnique('def456', 'WZZ7A', T0);
  ingestStats(statsFixture({ last1min: { end: T0 / 1000, messages: 1 } }), T0);

  const snapshot = snapshotForPersistence();
  resetStatsHistory();
  assert.equal(getDailyUniqueCounts().uniqueAircraftCount, 0);

  restoreFromSnapshot(snapshot, T0 + 5 * MINUTE);
  assert.equal(getDailyUniqueCounts().uniqueAircraftCount, 2);
  assert.equal(getDailyUniqueCounts().uniqueFlightsCount, 2);
});

test('restoring an older snapshot shape without uniqueHexes/uniqueFlights leaves fresh empty sets, not a crash', () => {
  ingestStats(statsFixture({ last1min: { end: T0 / 1000, messages: 1 } }), T0);
  const snapshot = snapshotForPersistence();
  delete snapshot.dailyAccumulator.uniqueHexes;
  delete snapshot.dailyAccumulator.uniqueFlights;
  resetStatsHistory();

  assert.doesNotThrow(() => restoreFromSnapshot(snapshot, T0 + 5 * MINUTE));
  assert.equal(getDailyUniqueCounts().uniqueAircraftCount, 0);
  // And the restored state must still support further recording, i.e. it's
  // a real Set, not left as undefined. Stays within the same restored day
  // (T0 + 5 min) so this doesn't itself trigger another rollover.
  recordDailyUnique('abc123', 'RYR4521', T0 + 5 * MINUTE);
  assert.equal(getDailyUniqueCounts().uniqueAircraftCount, 1);
});

test('getMaxRangeLastHourKm only considers samples from the last 60 minutes', () => {
  recordRangeSample(50, T0);
  recordRangeSample(500, T0 + 10 * MINUTE);
  assert.equal(getMaxRangeLastHourKm(T0 + 45 * MINUTE), 500);

  // At T0 + 90min, the window is [T0+30min, T0+90min] -- both earlier
  // samples (T0 and T0+10min) have aged out of it.
  recordRangeSample(20, T0 + 90 * MINUTE);
  assert.equal(getMaxRangeLastHourKm(T0 + 90 * MINUTE), 20);
});

test('getMaxRangeLastHourKm is 0 when nothing has been recorded yet', () => {
  assert.equal(getMaxRangeLastHourKm(T0), 0);
});

test('getTodayStartMs returns UTC midnight of the given day, matching todayDateString\'s boundary', () => {
  const midday = new Date('2026-03-15T14:23:00.000Z').getTime();
  assert.equal(getTodayStartMs(midday), new Date('2026-03-15T00:00:00.000Z').getTime());
});

test('getTodayStartMs is stable across the whole day, including right up to the boundary', () => {
  const justBeforeMidnight = new Date('2026-03-15T23:59:59.999Z').getTime();
  const justAfterMidnight = new Date('2026-03-16T00:00:00.001Z').getTime();
  assert.equal(getTodayStartMs(justBeforeMidnight), new Date('2026-03-15T00:00:00.000Z').getTime());
  assert.equal(getTodayStartMs(justAfterMidnight), new Date('2026-03-16T00:00:00.000Z').getTime());
});
