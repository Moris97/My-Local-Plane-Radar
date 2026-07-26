import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ingestStats, getHistory, getDailyAccumulator, getLatestStatsValues, resetStatsHistory } from './stats-history.js';

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

test('history is capped so it cannot grow unbounded', () => {
  for (let i = 0; i < 1500; i += 1) {
    ingestStats(statsFixture({ last1min: { end: i, messages: 1 } }));
  }
  assert.equal(getHistory().length, 1440);
  assert.equal(getHistory()[0].t, 1500 - 1440);
});
