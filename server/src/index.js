import { buildServer } from './server.js';
import { createSource } from './sources/index.js';
import { applyRawSnapshot, getTrackedAircraft } from './state.js';
import { toWireAircraftList } from './wire.js';
import { setAutoDetectedHome, getEffectiveHome } from './home.js';
import { ingestStats, getDailyAccumulator, getLatestStatsValues, recordRangeSample, getRangeSummary } from './stats-history.js';
import { upsertDailyStats } from './db.js';
import { evaluateAircraftRules, evaluateRangeRecordRule } from './notifications/rules.js';
import { pruneCooldowns } from './notifications/cooldown.js';
import { pruneTokens } from './settings-auth.js';
import { recordPosition, evictStaleTrails } from './trail-history.js';
import { recordSighting, flushDirtyRegistrations } from './stats-registrations.js';
import { resolveAirlineIcao } from './airline-lookup.js';
import { getAirlines } from './airlines-data.js';
import { distanceKm } from './range.js';
import { resolvePort } from './server-config.js';

const HOST = process.env.MLPR_HOST ?? '0.0.0.0';
const POLL_INTERVAL_MS = 1000;
const STATS_POLL_INTERVAL_MS = 15000;
const STATS_BROADCAST_INTERVAL_MS = 5000;
const DAILY_STATS_FLUSH_INTERVAL_MS = 45000;
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
// should still count as "still being seen right now" for both the range
// sample and the registration's lastSeenAt.
function recordRangeAndRegistrationSightings() {
  const home = getEffectiveHome();
  const airlines = getAirlines();
  let bestRangeKm = null;

  for (const aircraft of getTrackedAircraft()) {
    if (home && typeof aircraft.lat === 'number' && typeof aircraft.lon === 'number') {
      const km = distanceKm(home.lat, home.lon, aircraft.lat, aircraft.lon);
      if (bestRangeKm === null || km > bestRangeKm) bestRangeKm = km;
    }

    if (aircraft.registration) {
      recordSighting(aircraft.registration, {
        typeCode: aircraft.typeCode,
        airlineIcao: resolveAirlineIcao(aircraft, airlines),
      });
    }
  }

  if (bestRangeKm !== null) recordRangeSample(bestRangeKm);
}

async function pollStats() {
  const stats = await source.fetchStats();
  if (stats === null) return;

  const sample = ingestStats(stats);
  if (sample) {
    evaluateRangeRecordRule(sample.maxRangeKm);
  }
}

function broadcastStats(broadcast) {
  const { messagesPerSec, maxRangeKm } = getLatestStatsValues();
  broadcast({
    type: 'stats',
    aircraftCount: getTrackedAircraft().length,
    messagesPerSec,
    maxRangeKm,
  });
}

function flushDailyStats() {
  const accumulator = getDailyAccumulator();
  // Today's max/top-avg range come from our own Haversine sampling
  // (getRangeSummary), not accumulator.maxRangeKm -- that field only ever
  // reflects readsb's own all-time running record's value as observed
  // today, not a true daily max. See stats-history.js.
  const rangeSummary = getRangeSummary();
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
  });

  flushDirtyRegistrations();
}

async function main() {
  const { app, broadcast } = await buildServer();

  const receiverInfo = await source.fetchReceiverInfo();
  setAutoDetectedHome(receiverInfo);

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
  }, DAILY_STATS_FLUSH_INTERVAL_MS);

  setInterval(() => pruneCooldowns(), COOLDOWN_PRUNE_INTERVAL_MS);
  setInterval(() => pruneTokens(), COOLDOWN_PRUNE_INTERVAL_MS);
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
