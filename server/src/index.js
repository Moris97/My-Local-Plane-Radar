import { buildServer } from './server.js';
import { createSource } from './sources/index.js';
import { applyRawSnapshot, getTrackedAircraft } from './state.js';
import { toWireAircraftList } from './wire.js';
import { setAutoDetectedHome, getEffectiveHome } from './home.js';
import {
  ingestStats,
  getDailyAccumulator,
  getLatestStatsValues,
  recordRangeSample,
  getRangeSummary,
  getMaxRangeLastHourKm,
  recordDailyUnique,
  getDailyUniqueCounts,
  snapshotForPersistence,
  restoreFromSnapshot,
} from './stats-history.js';
import { upsertDailyStats, getConfigJSON, setConfigJSON, markFlightSeen, hasSeenFlight } from './db.js';
import { evaluateAircraftRules, evaluateRangeRecordRule, prunePendingFirstSeen } from './notifications/rules.js';
import { pruneCooldowns } from './notifications/cooldown.js';
import { reconfigureSmartHome, shutdownSmartHome } from './notifications/smart-home.js';
import { pruneTokens, pruneLoginAttempts } from './settings-auth.js';
import { recordPosition, evictStaleTrails } from './trail-history.js';
import { recordSighting, flushDirtyRegistrations } from './stats-registrations.js';
import { resolveAirlineIcao } from './airline-lookup.js';
import { getAirlines } from './airlines-data.js';
import { distanceKm, isRangeEligible } from './range.js';
import { recordAntennaSample, recordSignalReading, flushAntennaStatsIfDirty } from './antenna-stats.js';
import { resolvePort } from './server-config.js';

const HOST = process.env.MLPR_HOST ?? '0.0.0.0';
const POLL_INTERVAL_MS = 1000;
const STATS_POLL_INTERVAL_MS = 15000;
const STATS_BROADCAST_INTERVAL_MS = 5000;
const DAILY_STATS_FLUSH_INTERVAL_MS = 45000;
// Deliberately much less frequent than the small daily_stats row flush
// above: this snapshot carries the full in-progress 24h history (up to
// 1440 samples), a far bigger blob, and SD wear matters (hard rule: batch
// writes, minimize SD wear). Hourly by default, per explicit request --
// still always also written on graceful shutdown, so a routine
// systemctl restart/reboot loses at most this interval's worth of the
// current in-progress minute, not the whole day.
const STATS_HISTORY_SNAPSHOT_INTERVAL_MS = 60 * 60 * 1000;
const STATS_HISTORY_SNAPSHOT_CONFIG_KEY = 'statsHistorySnapshot';
const COOLDOWN_PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const TRAIL_EVICTION_INTERVAL_MS = 60 * 1000;

const source = createSource();

async function pollOnce(broadcast) {
  const raw = await source.fetchSnapshot();
  if (raw === null) return;

  const updated = applyRawSnapshot(raw);

  for (const aircraft of updated) {
    evaluateAircraftRules(aircraft);
    if (typeof aircraft.lat === 'number' && typeof aircraft.lon === 'number') {
      recordPosition(aircraft.hex, {
        lat: aircraft.lat,
        lon: aircraft.lon,
        altBaro: aircraft.altBaro,
        onGround: aircraft.onGround,
        t: Date.now(),
        // Lets the client (trail.js) tell an MLAT-derived position apart
        // from a genuine ADS-B one when it seeds a trail from
        // GET /api/trails -- MLAT-only smoothing/anomaly-rejection needs
        // this for points recorded before the current tab was even open,
        // not just ones arriving live over the WebSocket.
        sourceType: aircraft.sourceType,
      });
    }
  }

  recordRangeAndRegistrationSightings();

  broadcast({
    type: 'delta',
    now: Date.now() / 1000,
    updated: toWireAircraftList(updated),
  });
}

// Deliberately iterates *every* currently tracked aircraft each tick, not
// just this tick's delta (`updated` above) -- a stationary aircraft with
// unchanged tracked fields wouldn't show up in the delta every tick, but it
// should still count as "still being seen right now" for the range sample,
// the registration's lastSeenAt, the antenna band/sector maxima, and
// today's unique aircraft/flight sets. All of this is folded into one loop
// rather than four separate passes over the same (small) tracked-aircraft
// list each second.
function recordRangeAndRegistrationSightings() {
  const home = getEffectiveHome();
  const airlines = getAirlines();
  let bestRangeKm = null;

  for (const aircraft of getTrackedAircraft()) {
    const hasPosition = typeof aircraft.lat === 'number' && typeof aircraft.lon === 'number';

    // isRangeEligible excludes MLAT (and everything else that isn't
    // straight ADS-B) from range/antenna sampling -- see range.js. An MLAT
    // position doesn't say anything about *this* antenna's own reception
    // range, so letting it feed the range-record notification, the Stats
    // range chart, or the coverage map would inflate all three with
    // contacts this receiver never actually heard that far out.
    if (home && hasPosition && isRangeEligible(aircraft.sourceType)) {
      const km = distanceKm(home.lat, home.lon, aircraft.lat, aircraft.lon);
      if (bestRangeKm === null || km > bestRangeKm) bestRangeKm = km;

      recordAntennaSample({
        homeLat: home.lat,
        homeLon: home.lon,
        lat: aircraft.lat,
        lon: aircraft.lon,
        altBaro: aircraft.altBaro,
        onGround: aircraft.onGround,
      });
    }

    if (aircraft.registration) {
      recordSighting(aircraft.registration, {
        typeCode: aircraft.typeCode,
        airlineIcao: resolveAirlineIcao(aircraft, airlines),
      });
    }

    // Guarded the same way rules.js guards markAircraftSeen: a cheap SELECT
    // every tick, but the INSERT (an actual SD write) only ever fires once
    // per callsign, the first time it's seen -- not a per-tick write for
    // every already-known aircraft (hard rule 5).
    if (aircraft.flight && !hasSeenFlight(aircraft.flight)) markFlightSeen(aircraft.flight);
    recordDailyUnique(aircraft.hex, aircraft.flight);
  }

  if (bestRangeKm !== null) {
    recordRangeSample(bestRangeKm);
    // Same MLAT-filtered, self-computed reading "today"'s max range
    // (getRangeSummary) is already based on -- the all-time record used to
    // come from readsb's own stats.json total.max_distance instead (see
    // pollStats below), a completely different, unfiltered,
    // receiver-restart-resettable number that could (and did, live) read
    // *lower* than today's own more accurate figure -- a logically
    // impossible "all time < today" reading on the Stats panel. Feeding
    // both the daily and all-time record from this one source keeps them
    // consistent by construction.
    evaluateRangeRecordRule(bestRangeKm);
  }
}

async function pollStats() {
  const stats = await source.fetchStats();
  if (stats === null) return;

  ingestStats(stats);

  // `local` is absent in --net-only mode (no SDR attached, MLAT/network-only
  // feed) -- optional chaining rather than assuming it's always there.
  const local = stats.last1min?.local;
  if (local) {
    recordSignalReading(local.signal, local.peak_signal);
  }
}

function broadcastStats(broadcast) {
  const { messagesPerSec, maxRangeKm } = getLatestStatsValues();
  broadcast({
    type: 'stats',
    aircraftCount: getTrackedAircraft().length,
    messagesPerSec,
    maxRangeKm,
    maxRangeLastHourKm: getMaxRangeLastHourKm(),
  });
}

function flushDailyStats() {
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
}

function flushStatsHistorySnapshot() {
  setConfigJSON(STATS_HISTORY_SNAPSHOT_CONFIG_KEY, snapshotForPersistence());
}

async function main() {
  const { app, broadcast } = await buildServer();

  // Bridges the exact gap reported live: the 24h charts (aircraft
  // seen/with-position/range) read from in-memory state that's otherwise
  // lost on every restart, and re-flushing the daily_stats row after a
  // same-day restart with a freshly-reset (i.e. much smaller) in-memory
  // accumulator was silently overwriting that day's already-recorded
  // totals. Restoring before the poll loops below start means the first
  // client to connect after a restart already sees today's real numbers
  // instead of a reset chart. No-ops (leaves the fresh in-memory state
  // alone) if the stored snapshot isn't from today -- see
  // restoreFromSnapshot's own guard in stats-history.js.
  restoreFromSnapshot(getConfigJSON(STATS_HISTORY_SNAPSHOT_CONFIG_KEY, null));

  const receiverInfo = await source.fetchReceiverInfo();
  setAutoDetectedHome(receiverInfo);

  // No-ops if smart-home delivery isn't enabled/configured (server.js's PUT
  // handler re-calls this immediately whenever Settings changes it, so this
  // startup call only matters for whatever was already saved from before).
  reconfigureSmartHome();

  setInterval(() => {
    pollOnce(broadcast).catch((err) => app.log.error(err, 'aircraft poll failed'));
  }, POLL_INTERVAL_MS);

  setInterval(() => {
    pollStats().catch((err) => app.log.error(err, 'stats poll failed'));
  }, STATS_POLL_INTERVAL_MS);

  setInterval(() => broadcastStats(broadcast), STATS_BROADCAST_INTERVAL_MS);

  setInterval(() => {
    try {
      flushDailyStats();
    } catch (err) {
      app.log.error(err, 'daily stats flush failed');
    }
    try {
      // Same cadence as the daily stats flush above -- flushAntennaStatsIfDirty
      // is a no-op (no SD write at all) once a receiver's band/sector maxima
      // stop moving, so checking this often costs nothing extra.
      flushAntennaStatsIfDirty();
    } catch (err) {
      app.log.error(err, 'antenna stats flush failed');
    }
  }, DAILY_STATS_FLUSH_INTERVAL_MS);

  setInterval(() => {
    try {
      flushStatsHistorySnapshot();
    } catch (err) {
      app.log.error(err, 'stats history snapshot flush failed');
    }
  }, STATS_HISTORY_SNAPSHOT_INTERVAL_MS);

  // These three shared one interval constant already but each ran as its
  // own setInterval -- three timer wakeups an hour for what is really one
  // "do the hourly pruning" tick. Merged into one.
  setInterval(() => {
    pruneCooldowns();
    pruneTokens();
    pruneLoginAttempts();
    prunePendingFirstSeen();
  }, COOLDOWN_PRUNE_INTERVAL_MS);
  setInterval(() => {
    evictStaleTrails(new Set(getTrackedAircraft().map((aircraft) => aircraft.hex)));
  }, TRAIL_EVICTION_INTERVAL_MS);

  async function shutdown(signal) {
    app.log.info(`received ${signal}, shutting down`);
    try {
      flushDailyStats();
    } catch (err) {
      app.log.error(err, 'daily stats flush on shutdown failed');
    }
    try {
      flushStatsHistorySnapshot();
    } catch (err) {
      app.log.error(err, 'stats history snapshot flush on shutdown failed');
    }
    try {
      flushAntennaStatsIfDirty();
    } catch (err) {
      app.log.error(err, 'antenna stats flush on shutdown failed');
    }
    try {
      // Proactively publishes retained "offline" rather than waiting for
      // the broker to notice the TCP connection dropped and fall back to
      // the Will -- same end result, just faster/more deliberate for a
      // routine restart than a crash.
      shutdownSmartHome();
    } catch (err) {
      app.log.error(err, 'smart-home MQTT shutdown failed');
    }
    await app.close();
    process.exit(0);
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Resolved once at startup (env override > stored config > 1090).
  // Changing the port in Settings persists it but does not rebind a running
  // server -- the systemd unit is Restart=on-failure, so exiting to pick up
  // a new port would just stop the service. The UI says a manual restart is
  // required instead.
  const { port } = resolvePort();
  await app.listen({ port, host: HOST });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
