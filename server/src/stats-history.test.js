// Day boundaries here are local (see time-buckets.js); pin a real
// non-UTC zone so these assertions mean something on a UTC dev machine.
process.env.TZ = 'Europe/Warsaw';

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  ingestStats,
  getHistory,
  getDailyAccumulator,
  getLatestStatsValues,
  resetStatsHistory,
  recordRangeSample,
  recordTrackedCounts,
  getRangeSummary,
  getMaxRangeLastHourKm,
  getTodaysRangeSamples,
  getRangeSamples,
  recordDailyUnique,
  getDailyUniqueCounts,
  getTodayStartMs,
  snapshotForPersistence,
  restoreFromSnapshot,
} from './stats-history.js';

beforeEach(() => {
  resetStatsHistory();
});

// Only the receiver-level fields matter now: aircraft counts come from
// MLPR's own tracked set via recordTrackedCounts, never from stats.json.
function statsFixture(overrides = {}) {
  return {
    // Still present so the "we don't read these" test below has something
    // to prove -- readsb really does publish them.
    aircraft_with_pos: 99,
    aircraft_without_pos: 99,
    last1min: { end: 1700000000, messages: 300 },
    total: { max_distance: 200000 },
    ...overrides,
  };
}

// Records a tracked-count reading and then a stats sample, the way index.js
// does (aircraft poll every second, stats poll every ~15).
function ingestWithCounts(withPos, withoutPos, overrides = {}, now = undefined) {
  recordTrackedCounts(withPos + withoutPos, withPos, withoutPos);
  return now === undefined ? ingestStats(statsFixture(overrides)) : ingestStats(statsFixture(overrides), now);
}

test('ingesting without a last1min period is ignored', () => {
  assert.equal(ingestStats({}), null);
  assert.equal(getHistory().length, 0);
});

test('a valid stats snapshot produces one history sample', () => {
  const sample = ingestWithCounts(3, 1);
  assert.equal(sample.aircraftCount, 4);
  assert.equal(sample.withPos, 3);
  assert.equal(sample.withoutPos, 1);
  assert.equal(sample.messagesPerMinute, 300);
  assert.equal(getHistory().length, 1);
});

// readsb keeps its own aircraft accounting with its own timeouts, so its
// counters answer "how many aircraft right now" differently from the set
// the map, the List panel and the live tiles are all drawn from. Reading
// them here put two different answers on one Stats screen.
test('aircraft counts come from the tracked set, not from stats.json\'s own counters', () => {
  const sample = ingestWithCounts(2, 1); // fixture says 99/99
  assert.equal(sample.withPos, 2);
  assert.equal(sample.withoutPos, 1);
  assert.equal(sample.aircraftCount, 3);
});

test('nothing is recorded until the aircraft poll has reported a count at least once', () => {
  assert.equal(ingestStats(statsFixture()), null);
  assert.equal(getHistory().length, 0);
});

test('re-ingesting the same minute is a no-op', () => {
  ingestWithCounts(3, 1);
  const second = ingestWithCounts(3, 1);
  assert.equal(second, null);
  assert.equal(getHistory().length, 1);
});

test('a newer minute appends a new sample', () => {
  ingestWithCounts(3, 1);
  ingestWithCounts(3, 1, { last1min: { end: 1700000060, messages: 250 } });
  assert.equal(getHistory().length, 2);
});

test('getLatestStatsValues reflects the most recent sample', () => {
  ingestWithCounts(3, 1, { last1min: { end: 1700000000, messages: 300 } });
  ingestWithCounts(3, 1, { last1min: { end: 1700000060, messages: 600 } });
  const values = getLatestStatsValues();
  assert.equal(values.messagesPerSec, 10);
});

// readsb's own total.max_distance used to ride along here and all the way
// into the browser's live state, unfiltered and MLAT-inclusive, sitting one
// property away from our own MLAT-excluded figures -- with nothing ever
// displaying it. That pairing produced a live "today > all time" inversion
// once already.
test('readsb\'s own max distance is not carried anywhere', () => {
  const sample = ingestWithCounts(3, 1, { total: { max_distance: 200000 } });
  assert.equal('maxRangeKm' in sample, false);
  assert.equal('maxRangeKm' in getLatestStatsValues(), false);
  assert.equal('maxRangeKm' in getDailyAccumulator(), false);
});

test('daily accumulator takes the max aircraft count and sums messages', () => {
  ingestWithCounts(2, 0, { last1min: { end: 60, messages: 100 } });
  ingestWithCounts(5, 0, { last1min: { end: 120, messages: 150 } });
  ingestWithCounts(1, 0, { last1min: { end: 180, messages: 50 } });

  const acc = getDailyAccumulator();
  assert.equal(acc.maxAircraft, 5);
  assert.equal(acc.totalMessages, 300);
});

// readsb's last1min is a *sliding* 60-second window rewritten continuously,
// so a 15s poll sees a fresh `end` (and a fresh, overlapping message count)
// four times a minute. Counting each of those into the day's total counted
// most messages roughly four times over.
test('messages are counted once per minute, not once per poll, when several polls land in the same minute', () => {
  ingestWithCounts(3, 1, { last1min: { end: 600, messages: 100 } });
  ingestWithCounts(3, 1, { last1min: { end: 615, messages: 110 } });
  ingestWithCounts(3, 1, { last1min: { end: 630, messages: 120 } });
  ingestWithCounts(3, 1, { last1min: { end: 660, messages: 200 } }); // next minute

  assert.equal(getDailyAccumulator().totalMessages, 300); // 100 + 200
});

test('daily accumulator tracks sum/max separately for with-pos and without-pos, and a sample count for averaging', () => {
  ingestWithCounts(2, 1, { last1min: { end: 1, messages: 100 } });
  ingestWithCounts(6, 3, { last1min: { end: 2, messages: 100 } });

  const acc = getDailyAccumulator();
  assert.equal(acc.sampleCount, 2);
  assert.equal(acc.sumAircraft, 12); // (2+1) + (6+3)
  assert.equal(acc.sumWithPos, 8);
  assert.equal(acc.maxWithPos, 6);
  assert.equal(acc.sumWithoutPos, 4);
  assert.equal(acc.maxWithoutPos, 3);
});

// The 24h charts read this array, so it has to hold a real 24 hours. It
// used to be capped at a flat 1440 entries on the assumption of one sample
// per minute -- with readsb's sliding window feeding four samples a minute
// that cap held about six hours, and the charts silently started mid-day.
test('several samples inside one minute collapse into a single history entry, newest winning', () => {
  ingestWithCounts(1, 0, { last1min: { end: 600, messages: 100 } });
  ingestWithCounts(2, 0, { last1min: { end: 615, messages: 110 } });
  ingestWithCounts(3, 0, { last1min: { end: 630, messages: 120 } });

  assert.equal(getHistory().length, 1);
  assert.equal(getHistory()[0].aircraftCount, 3);
});

test('history keeps a full day of minutes and evicts by age, not by a raw sample count', () => {
  const start = 1700000000;
  // Two full days, one sample a minute: everything older than the rolling
  // window falls off, everything inside it stays -- 1440 minutes' worth,
  // far more than the old flat cap left after four-a-minute sampling.
  for (let i = 0; i < 2 * 24 * 60; i += 1) {
    ingestWithCounts(3, 1, { last1min: { end: start + i * 60, messages: 1 } });
  }

  const kept = getHistory();
  assert.ok(kept.length >= 24 * 60, `expected at least 24h of samples, got ${kept.length}`);
  const spanHours = (kept[kept.length - 1].t - kept[0].t) / 3600;
  assert.ok(spanHours >= 24 && spanHours <= 25, `expected a ~24-25h window, got ${spanHours}h`);
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

// Same SD-write reasoning as the antenna cells: these samples are persisted
// as a JSON blob, where a raw double is ~17 characters of noise.
test('range samples are stored rounded to 10 m', () => {
  recordRangeSample(300.20524528563544, T0);
  recordRangeSample(150.98765432109876, T0 + MINUTE);
  assert.deepEqual(getRangeSamples().map((s) => s.km), [300.21, 150.99]);
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
  ingestWithCounts(3, 1, { last1min: { end: T0 / 1000, messages: 300 } }, T0);
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

// The two halves of a snapshot have deliberately different guards: the
// day-scoped accumulator must not inherit yesterday's numbers, but the
// rolling 24h series should survive a restart that crosses midnight --
// otherwise every such restart empties the 24h charts.
test('a snapshot from a previous day restores the rolling series but not the day accumulator', () => {
  ingestWithCounts(9, 0, { last1min: { end: T0 / 1000, messages: 999 } }, T0);
  recordRangeSample(500, T0);
  const staleSnapshot = snapshotForPersistence();
  resetStatsHistory();

  const nextDay = T0 + 24 * 60 * MINUTE;
  restoreFromSnapshot(staleSnapshot, nextDay);

  assert.equal(getDailyAccumulator().sampleCount, 0);
  assert.equal(getRangeSummary().maxRangeKm, 0, 'yesterday\'s samples are not part of today\'s summary');
  assert.equal(getHistory().length, 1);
  assert.equal(getRangeSamples().length, 1, 'still available to the rolling 24h charts');
});

test('a snapshot older than the rolling window is dropped entirely', () => {
  ingestWithCounts(3, 1, { last1min: { end: T0 / 1000, messages: 10 } }, T0);
  recordRangeSample(500, T0);
  const ancient = snapshotForPersistence();
  resetStatsHistory();

  restoreFromSnapshot(ancient, T0 + 5 * 24 * 60 * MINUTE);

  assert.equal(getRangeSamples().length, 0);
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

test('getTodayStartMs returns local midnight of the given day, matching todayDateString\'s boundary', () => {
  const midday = new Date(2026, 2, 15, 14, 23).getTime();
  assert.equal(getTodayStartMs(midday), new Date(2026, 2, 15).getTime());
});

// Instants built from local calendar fields on purpose: the boundary being
// tested *is* the local one, and a UTC literal here would sit on the other
// side of it for most of the world.
test('getTodayStartMs is stable across the whole day, including right up to the boundary', () => {
  const justBeforeMidnight = new Date(2026, 2, 15, 23, 59, 59, 999).getTime();
  const justAfterMidnight = new Date(2026, 2, 16, 0, 0, 0, 1).getTime();
  assert.equal(getTodayStartMs(justBeforeMidnight), new Date(2026, 2, 15).getTime());
  assert.equal(getTodayStartMs(justAfterMidnight), new Date(2026, 2, 16).getTime());
});

// The whole point of the local boundary: a reading taken at 23:30 local on
// a UTC+2 receiver belongs to that evening, not to the next calendar day
// the way a UTC boundary filed it.
test('a late local evening still belongs to today, not to tomorrow', () => {
  const lateEvening = new Date(2026, 6, 27, 23, 30).getTime();
  assert.equal(getTodayStartMs(lateEvening), new Date(2026, 6, 27).getTime());
});
