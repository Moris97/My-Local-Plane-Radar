import { upsertDailyStats, getConfigJSON, setConfigJSON, runBatch } from './db.js';
import {
  getDailyAccumulator,
  getRangeSummary,
  getDailyUniqueCounts,
  snapshotForPersistence,
  restoreFromSnapshot,
} from './stats-history.js';
import { flushDirtySeenFlights, resetSeenFlightsCache } from './seen-flights.js';
import { flushDirtyAircraftSeen, resetAircraftSeenCache } from './aircraft-seen.js';
import { flushDirtyAircraftTracked, resetAircraftTrackedCache } from './aircraft-tracked.js';
import { flushDirtyRegistrations, resetRegistrationsCache } from './stats-registrations.js';
import { flushAntennaStatsIfDirty, reloadAntennaStatsFromDb } from './antenna-stats.js';
import { flushAllTimeMaxRangeKmIfDirty, invalidateAllTimeMaxRangeKmCache } from './notifications/rules.js';

// The bridge between "what is currently in RAM" and "what is in SQLite".
//
// Several modules in this app keep authoritative state in memory and only
// write it out periodically (45s for the daily row and the dirty trackers,
// 5 min for the antenna blob, 1 h for the stats-history snapshot). That is
// deliberate -- hard rule 5, SD wear -- but it means a backup taken or
// restored at an arbitrary moment sees a stale database unless something
// deliberately synchronises the two. Both halves of that live here:
//
//   - flushAllRuntimeState() before an export, so the file actually
//     contains today's numbers rather than everything up to the last tick.
//   - flushAllRuntimeState() then reloadRuntimeStateFromDb() around an
//     import, so the in-memory copies don't quietly overwrite the freshly
//     restored rows at the next periodic flush. Without the reload an
//     import looks like it worked and then undoes itself within a minute.
//
// It lives in its own module rather than in config-backup.js on purpose:
// config-backup.js is the pure "SQLite rows in, SQLite rows out" half and
// its test boots with nothing but a temp database, whereas this file
// necessarily reaches into the notification stack (rules.js pulls in
// mqtt-client.js and everything else) to invalidate one cached number.

export const STATS_HISTORY_SNAPSHOT_CONFIG_KEY = 'statsHistorySnapshot';

// The five writes below used to be five separate SQLite transactions (one
// implicit one for upsertDailyStats's bare .run(), four more from the
// flushDirtyX() calls each reaching their own runBatch/upsert* internally)
// on every single flush tick. Wrapping the whole function in one outer
// runBatch collapses that to one commit -- runBatch is reentrant via
// SAVEPOINT (see db.js), so each of these still commits/rolls back
// correctly on its own if ever called outside this function too.
export function flushDailyStats() {
  runBatch(() => {
    const accumulator = getDailyAccumulator();
    // Today's max/top-avg range come from our own Haversine sampling
    // (getRangeSummary), not accumulator.maxRangeKm -- that field only ever
    // reflects readsb's own all-time running record's value as observed
    // today, not a true daily max. See stats-history.js.
    const rangeSummary = getRangeSummary();
    const uniqueCounts = getDailyUniqueCounts();
    const avgAircraft = accumulator.sampleCount ? accumulator.sumAircraft / accumulator.sampleCount : 0;
    const avgWithPos = accumulator.sampleCount ? accumulator.sumWithPos / accumulator.sampleCount : 0;
    const avgWithoutPos = accumulator.sampleCount ? accumulator.sumWithoutPos / accumulator.sampleCount : 0;

    upsertDailyStats(accumulator.date, {
      maxAircraft: accumulator.maxAircraft,
      totalMessages: accumulator.totalMessages,
      maxRangeKm: rangeSummary.maxRangeKm,
      avgAircraft,
      avgWithPos,
      maxWithPos: accumulator.maxWithPos,
      avgWithoutPos,
      maxWithoutPos: accumulator.maxWithoutPos,
      rangeTopAvgKm: rangeSummary.rangeTopAvgKm,
      uniqueAircraftCount: uniqueCounts.uniqueAircraftCount,
      uniqueFlightsCount: uniqueCounts.uniqueFlightsCount,
    });

    flushDirtyRegistrations();
    flushDirtySeenFlights();
    flushDirtyAircraftSeen();
    flushDirtyAircraftTracked();
    // Same periodic tick (and the graceful-shutdown call to this same
    // function) now also covers the all-time range record -- see
    // evaluateRangeRecordRule in rules.js for why that write was moved off
    // the per-second poll loop.
    flushAllTimeMaxRangeKmIfDirty();
  });
}

export function flushStatsHistorySnapshot() {
  setConfigJSON(STATS_HISTORY_SNAPSHOT_CONFIG_KEY, snapshotForPersistence());
}

// Everything the periodic timers would eventually write, written now. Used
// by both backup directions -- the export needs it so the file is complete,
// the import needs it because reloadRuntimeStateFromDb() below throws the
// in-memory copies away and anything still dirty at that point would simply
// be lost (up to 45s of sightings, 5 min of antenna samples, an hour of
// chart history).
export function flushAllRuntimeState() {
  runBatch(() => {
    flushDailyStats();
    flushStatsHistorySnapshot();
    flushAntennaStatsIfDirty();
  });
}

// Drops every in-memory copy of something that also lives in SQLite, so the
// next read lazily picks up whatever the import just merged in. Called only
// after a successful restore.
export function reloadRuntimeStateFromDb() {
  resetRegistrationsCache();
  resetSeenFlightsCache();
  resetAircraftSeenCache();
  resetAircraftTrackedCache();
  reloadAntennaStatsFromDb();
  invalidateAllTimeMaxRangeKmCache();
  // stats-history is the one that can't just be dropped and lazily reread:
  // nothing reloads it on demand, it is only ever seeded from the snapshot
  // blob at startup. This is exactly the startup path, run again.
  restoreFromSnapshot(getConfigJSON(STATS_HISTORY_SNAPSHOT_CONFIG_KEY, null));
}
