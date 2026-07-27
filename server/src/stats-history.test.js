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
  getTodaysRangeSamples,
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
