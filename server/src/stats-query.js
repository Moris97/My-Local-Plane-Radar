import { getHistory, getRangeSamples, averageOfTopFraction } from './stats-history.js';
import { getDailyStatsSince, getAllDailyStats, getEarliestDailyStatsDate } from './db.js';
import { granularityForRange, rangeStartMs, bucketize, localDayString, startOfLocalDayMs } from './time-buckets.js';

const TOP_FRACTION = 0.1;

// One granularity per range for the whole Stats screen -- every chart that
// buckets over time (this module's history series, but also the new-
// registrations and per-type/airline trend charts in server.js) resolves
// it through here, so they can't disagree with each other about what a
// bucket means.
export function granularityFor(range, now = Date.now()) {
  const earliestDate = getEarliestDailyStatsDate();
  const earliestDataMs = earliestDate ? startOfLocalDayMs(earliestDate) : null;
  return granularityForRange(range, { earliestDataMs, now });
}

function avg(values) {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

function max(values) {
  return values.length ? Math.max(...values) : 0;
}

function mergeBucketsByKey(bucketArrays) {
  const merged = new Map();
  for (const buckets of bucketArrays) {
    for (const b of buckets) {
      merged.set(b.bucket, { ...(merged.get(b.bucket) ?? { bucket: b.bucket }), ...b });
    }
  }
  return Array.from(merged.values()).sort((a, b) => (a.bucket < b.bucket ? -1 : a.bucket > b.bucket ? 1 : 0));
}

// Chart 1 (aircraft count), chart 2 (with/without position), and chart 3
// (range) all come from this one bucketed series. 24h reads from the
// in-memory minute-level history + per-minute Haversine range samples
// (both still bucketed, just to the hour, so a 24h view isn't 1440 points);
// every other range reads from the daily_stats rows written at each day's
// rollover, bucketed coarser the longer the range (see time-buckets.js).
export function getStatsHistoryForRange(range, now = Date.now()) {
  const granularity = granularityFor(range, now);
  const since = rangeStartMs(range, now);

  if (range === '24h') {
    const samples = getHistory().filter((s) => s.t * 1000 >= since);
    const rangeSamples = getRangeSamples().filter((s) => s.t >= since);

    const mainBuckets = bucketize(samples, {
      getTime: (s) => s.t * 1000,
      getValue: (s) => s,
      granularity,
      reducer: (values) => ({
        avgAircraft: avg(values.map((v) => v.aircraftCount)),
        maxAircraft: max(values.map((v) => v.aircraftCount)),
        avgWithPos: avg(values.map((v) => v.withPos)),
        maxWithPos: max(values.map((v) => v.withPos)),
        avgWithoutPos: avg(values.map((v) => v.withoutPos)),
        maxWithoutPos: max(values.map((v) => v.withoutPos)),
      }),
    });

    const rangeBuckets = bucketize(rangeSamples, {
      getTime: (s) => s.t,
      getValue: (s) => s.km,
      granularity,
      reducer: (values) => ({
        maxRangeKm: max(values),
        rangeTopAvgKm: averageOfTopFraction(values, TOP_FRACTION),
      }),
    });

    return mergeBucketsByKey([mainBuckets, rangeBuckets]);
  }

  const sinceDate = since === 0 ? null : localDayString(since);
  const rows = sinceDate ? getDailyStatsSince(sinceDate) : getAllDailyStats();

  return bucketize(rows, {
    // A daily_stats key is a local calendar day, so it has to be turned
    // back into local midnight before being re-bucketed -- `new Date(
    // '2026-08-04')` would parse it as UTC midnight, which lands on the
    // previous day west of Greenwich and would relabel every bucket there.
    getTime: (r) => startOfLocalDayMs(r.date),
    getValue: (r) => r,
    granularity,
    reducer: (values) => ({
      avgAircraft: avg(values.map((v) => v.avg_aircraft)),
      maxAircraft: max(values.map((v) => v.max_aircraft)),
      avgWithPos: avg(values.map((v) => v.avg_with_pos)),
      maxWithPos: max(values.map((v) => v.max_with_pos)),
      avgWithoutPos: avg(values.map((v) => v.avg_without_pos)),
      maxWithoutPos: max(values.map((v) => v.max_without_pos)),
      maxRangeKm: max(values.map((v) => v.max_range_km)),
      rangeTopAvgKm: avg(values.map((v) => v.range_top_avg_km)),
    }),
  });
}
