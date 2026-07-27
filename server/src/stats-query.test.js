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

  statsHistory.ingestStats(
    { aircraft_with_pos: 3, aircraft_without_pos: 1, last1min: { end: now / 1000, messages: 60 }, total: { max_distance: 100000 } },
    now,
  );
  statsHistory.ingestStats(
    {
      aircraft_with_pos: 5,
      aircraft_without_pos: 0,
      last1min: { end: now / 1000 + 60, messages: 90 },
      total: { max_distance: 150000 },
    },
    now + 60000,
  );
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

test('1y range buckets daily_stats rows by ISO week', () => {
  db.upsertDailyStats('2026-05-04', { maxAircraft: 3, totalMessages: 10, maxRangeKm: 10, rangeTopAvgKm: 10 });
  db.upsertDailyStats('2026-05-05', { maxAircraft: 7, totalMessages: 10, maxRangeKm: 20, rangeTopAvgKm: 20 });

  const now = new Date('2026-05-10T00:00:00Z').getTime();
  const buckets = getStatsHistoryForRange('1y', now);
  // Both dates are in the same ISO week (2026-W19) -- should merge into one bucket.
  const week = buckets.find((b) => b.bucket === '2026-W19');
  assert.notEqual(week, undefined);
  assert.equal(week.maxAircraft, 7);
});

test('"all" range has no lower time bound', () => {
  db.upsertDailyStats('2020-01-01', { maxAircraft: 1, totalMessages: 1, maxRangeKm: 1 });
  const buckets = getStatsHistoryForRange('all', Date.now());
  assert.ok(buckets.some((b) => b.bucket === '2020-01'));
});
