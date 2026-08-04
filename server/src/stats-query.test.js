// Day boundaries here are local (see time-buckets.js); pin a real
// non-UTC zone so these assertions mean something on a UTC dev machine.
process.env.TZ = 'Europe/Warsaw';

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';

const tmpDir = mkdtempSync(join(tmpdir(), 'mlpr-stats-query-test-'));
process.env.MLPR_DB_PATH = join(tmpDir, 'test.db');

const db = await import('./db.js');
const statsHistory = await import('./stats-history.js');
const { getStatsHistoryForRange } = await import('./stats-query.js');

after(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  statsHistory.resetStatsHistory();
});

test('24h range buckets the in-memory history and range samples hourly', () => {
  const now = new Date('2026-03-10T12:00:00Z').getTime();

  // Aircraft counts reach stats-history through recordTrackedCounts (fed by
  // index.js's aircraft poll from MLPR's own tracked set), not through the
  // stats.json payload -- see stats-history.js.
  statsHistory.recordTrackedCounts(4, 3, 1);
  statsHistory.ingestStats({ last1min: { end: now / 1000, messages: 60 } }, now);
  statsHistory.recordTrackedCounts(5, 5, 0);
  statsHistory.ingestStats({ last1min: { end: now / 1000 + 60, messages: 90 } }, now + 60000);
  statsHistory.recordRangeSample(120, now);
  statsHistory.recordRangeSample(200, now + 60000);

  const buckets = getStatsHistoryForRange('24h', now + 60000);
  assert.equal(buckets.length, 1); // both samples fall in the same hour
  const bucket = buckets[0];
  assert.equal(bucket.maxAircraft, 5);
  assert.equal(bucket.avgAircraft, (4 + 5) / 2);
  assert.equal(bucket.maxRangeKm, 200);
});

test('24h range returns an empty array when nothing has been recorded', () => {
  assert.deepEqual(getStatsHistoryForRange('24h', Date.now()), []);
});

test('7d range reads from daily_stats, bucketed daily, only rows within the window', () => {
  const now = new Date('2026-04-10T00:00:00Z').getTime();
  db.upsertDailyStats('2026-04-09', {
    maxAircraft: 10,
    totalMessages: 100,
    maxRangeKm: 50,
    avgAircraft: 5,
    rangeTopAvgKm: 45,
  });
  db.upsertDailyStats('2026-04-08', {
    maxAircraft: 20,
    totalMessages: 200,
    maxRangeKm: 80,
    avgAircraft: 8,
    rangeTopAvgKm: 70,
  });
  db.upsertDailyStats('2026-03-01', { maxAircraft: 999, totalMessages: 1, maxRangeKm: 1 }); // outside 7d window

  const buckets = getStatsHistoryForRange('7d', now);
  const dates = buckets.map((b) => b.bucket);
  assert.equal(dates.includes('2026-04-09'), true);
  assert.equal(dates.includes('2026-04-08'), true);
  assert.equal(dates.includes('2026-03-01'), false);
});

// Granularity follows how much data the range actually covers, not the
// range's name: a young install asking for 1y/all used to get one lone
// monthly bar (or a single dot on a line chart) for its two days of data.
test('a young install gets daily buckets even on the 1y/all ranges', () => {
  db.upsertDailyStats('2026-05-04', { maxAircraft: 3, totalMessages: 10, maxRangeKm: 10, rangeTopAvgKm: 10 });
  db.upsertDailyStats('2026-05-05', { maxAircraft: 7, totalMessages: 10, maxRangeKm: 20, rangeTopAvgKm: 20 });

  const now = new Date('2026-05-06T00:00:00Z').getTime();
  for (const range of ['1y', 'all']) {
    const keys = getStatsHistoryForRange(range, now).map((b) => b.bucket);
    assert.ok(
      keys.includes('2026-05-04') && keys.includes('2026-05-05'),
      `${range} should bucket a young install's data by day, got ${keys.join(', ')}`,
    );
  }
});

test('1y range buckets daily_stats rows by ISO week once there is more than a couple of months of data', () => {
  db.upsertDailyStats('2025-06-01', { maxAircraft: 1, totalMessages: 1, maxRangeKm: 1, rangeTopAvgKm: 1 });
  db.upsertDailyStats('2026-05-04', { maxAircraft: 3, totalMessages: 10, maxRangeKm: 10, rangeTopAvgKm: 10 });
  db.upsertDailyStats('2026-05-05', { maxAircraft: 7, totalMessages: 10, maxRangeKm: 20, rangeTopAvgKm: 20 });

  const now = new Date('2026-05-10T00:00:00Z').getTime();
  const buckets = getStatsHistoryForRange('1y', now);
  // Both May dates are in the same ISO week (2026-W19) -- should merge into one bucket.
  const week = buckets.find((b) => b.bucket === '2026-W19');
  assert.notEqual(week, undefined);
  assert.equal(week.maxAircraft, 7);
});

test('"all" range has no lower time bound, and goes monthly once the install is years old', () => {
  db.upsertDailyStats('2020-01-01', { maxAircraft: 1, totalMessages: 1, maxRangeKm: 1 });
  const buckets = getStatsHistoryForRange('all', Date.now());
  assert.ok(buckets.some((b) => b.bucket === '2020-01'));
});
