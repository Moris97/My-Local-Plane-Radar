import { test } from 'node:test';
import assert from 'node:assert/strict';
import { granularityForRange, rangeStartMs, bucketKey, bucketize } from './time-buckets.js';

const NOW = new Date('2026-03-15T00:00:00Z').getTime();
const DAYS = 24 * 60 * 60 * 1000;

test('granularityForRange maps each range to the expected granularity for a long-running install', () => {
  const old = { earliestDataMs: NOW - 5 * 365 * DAYS, now: NOW };
  assert.equal(granularityForRange('24h', old), 'hour');
  assert.equal(granularityForRange('7d', old), 'day');
  assert.equal(granularityForRange('31d', old), 'day');
  assert.equal(granularityForRange('1y', old), 'week');
  assert.equal(granularityForRange('all', old), 'month');
});

// The point of the whole adaptive scheme: an install with two days of data
// showed one lone monthly bar on 1y/all before this.
test('granularityForRange falls back to daily buckets on a young install, whatever the range asks for', () => {
  const young = { earliestDataMs: NOW - 2 * DAYS, now: NOW };
  assert.equal(granularityForRange('1y', young), 'day');
  assert.equal(granularityForRange('all', young), 'day');
});

test('granularityForRange steps up to weeks, then months, as an install accumulates data', () => {
  assert.equal(granularityForRange('all', { earliestDataMs: NOW - 100 * DAYS, now: NOW }), 'week');
  assert.equal(granularityForRange('all', { earliestDataMs: NOW - 3 * 365 * DAYS, now: NOW }), 'month');
});

test('granularityForRange never goes finer than the range window itself, even with older data', () => {
  // 31d asks for a month regardless of the install having years of history.
  assert.equal(granularityForRange('31d', { earliestDataMs: 0, now: NOW }), 'day');
});

// No daily_stats rows at all (a first-run install) means there is nothing
// to draw either way, so the safe fallback is the range's own window --
// the coarse answer, never a chart with thousands of empty buckets.
test('granularityForRange falls back to the range window when the install start date is unknown', () => {
  assert.equal(granularityForRange('all', { earliestDataMs: null, now: NOW }), 'month');
  assert.equal(granularityForRange('1y', { earliestDataMs: null, now: NOW }), 'week');
});

test('rangeStartMs computes the expected cutoff for each range', () => {
  const now = new Date('2026-03-15T00:00:00Z').getTime();
  const DAY = 24 * 60 * 60 * 1000;
  assert.equal(rangeStartMs('24h', now), now - DAY);
  assert.equal(rangeStartMs('7d', now), now - 7 * DAY);
  assert.equal(rangeStartMs('31d', now), now - 31 * DAY);
  assert.equal(rangeStartMs('1y', now), now - 365 * DAY);
  assert.equal(rangeStartMs('all', now), 0);
});

test('bucketKey formats hour/day/month keys correctly', () => {
  const t = new Date('2026-03-15T14:37:00Z').getTime();
  assert.equal(bucketKey(t, 'hour'), '2026-03-15T14');
  assert.equal(bucketKey(t, 'day'), '2026-03-15');
  assert.equal(bucketKey(t, 'month'), '2026-03');
});

test('bucketKey week format matches ISO 8601 week numbering, including year-boundary edge cases', () => {
  // Cross-checked against Python's datetime.date.isocalendar().
  const cases = [
    ['2026-01-04T12:00:00Z', '2026-W01'],
    ['2026-01-01T12:00:00Z', '2026-W01'],
    ['2025-12-29T12:00:00Z', '2026-W01'], // late-Dec date belonging to next year's week 1
    ['2027-01-01T12:00:00Z', '2026-W53'], // Jan 1 belonging to previous year's week 53
    ['2026-12-31T12:00:00Z', '2026-W53'],
    ['2026-06-15T12:00:00Z', '2026-W25'],
  ];
  for (const [date, expected] of cases) {
    assert.equal(bucketKey(new Date(date).getTime(), 'week'), expected, date);
  }
});

test('bucketize groups by bucket key, sorts ascending, and applies the reducer', () => {
  const items = [
    { t: new Date('2026-03-02T00:00:00Z').getTime(), v: 10 },
    { t: new Date('2026-03-01T00:00:00Z').getTime(), v: 4 },
    { t: new Date('2026-03-01T12:00:00Z').getTime(), v: 6 },
  ];
  const result = bucketize(items, {
    getTime: (i) => i.t,
    getValue: (i) => i.v,
    granularity: 'day',
    reducer: (values) => ({ avg: values.reduce((a, b) => a + b, 0) / values.length, max: Math.max(...values) }),
  });
  assert.deepEqual(result, [
    { bucket: '2026-03-01', avg: 5, max: 6 },
    { bucket: '2026-03-02', avg: 10, max: 10 },
  ]);
});

test('bucketize returns an empty array for no items', () => {
  assert.deepEqual(bucketize([], { getTime: () => 0, getValue: () => 0, granularity: 'day', reducer: () => ({}) }), []);
});
