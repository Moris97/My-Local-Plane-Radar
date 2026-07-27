import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bucketGranularityForRange, rangeStartMs, bucketKey, bucketize } from './time-buckets.js';

test('bucketGranularityForRange maps each range to the confirmed granularity', () => {
  assert.equal(bucketGranularityForRange('24h'), 'hour');
  assert.equal(bucketGranularityForRange('7d'), 'day');
  assert.equal(bucketGranularityForRange('31d'), 'day');
  assert.equal(bucketGranularityForRange('1y'), 'week');
  assert.equal(bucketGranularityForRange('all'), 'month');
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
