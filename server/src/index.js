import { buildServer } from './server.js';
import { createSource } from './sources/index.js';
import { applyRawSnapshot, getTrackedAircraft } from './state.js';
import { toWireAircraftList } from './wire.js';
import { setAutoDetectedHome, getEffectiveHome } from './home.js';
import {
  ingestStats,
  getLatestStatsValues,
  recordRangeSample,
  recordTrackedCounts,
  getMaxRangeLastHourKm,
  recordDailyUnique,
  restoreFromSnapshot,
} from './stats-history.js';
import { getConfigJSON } from './db.js';
import {
  flushDailyStats,
  flushStatsHistorySnapshot,
  STATS_HISTORY_SNAPSHOT_CONFIG_KEY,
} from './runtime-state.js';
import { noteFlightSeen } from './seen-flights.js';
import { noteAircraftSeen } from './aircraft-seen.js';
import { touchAircraftTracked } from './aircraft-tracked.js';
import { evaluateAircraftRules, evaluateRangeRecordRule, evaluateReceiverSilenceRule, prunePendingFirstSeen, setUiEventSender } from './notifications/rules.js';
import { pruneCooldowns } from './notifications/cooldown.js';
import { reconfigureSmartHome, shutdownSmartHome } from './notifications/smart-home.js';
import { pruneTokens, pruneLoginAttempts } from './settings-auth.js';
import { recordPosition, evictStaleTrails } from './trail-history.js';
import { evictStaleCircling } from './notifications/circling-detector.js';
import { recordSighting } from './stats-registrations.js';
import { resolveAirlineIcao } from './airline-lookup.js';
import { getAirlines } from './airlines-data.js';
import { distanceKm, isRangeEligible, roundKm } from './range.js';
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
// Deliberately much slower than the 45s daily-stats flush this used to
// share: the antenna blob is by far the largest thing this app writes to
// the SD card (a full rewrite of every band/sector cell, ~40 KB), and
// while a receiver is still filling in its coverage almost every tick has
// *something* new, so "only when dirty" alone doesn't bound it. Losing up
// to five minutes of new maxima to an unclean shutdown is irrelevant --
// they are best-ever records that the next contact re-establishes.
const ANTENNA_STATS_FLUSH_INTERVAL_MS = 5 * 60 * 1000;
const COOLDOWN_PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const TRAIL_EVICTION_INTERVAL_MS = 60 * 1000;

const source = createSource();

async function pollOnce(broadcast) {
  const raw = await source.fetchSnapshot();

  // "Activity" means at least one tracked hex this tick, position or not --
  // a Mode-S-only contact still proves the receiver is alive. Evaluated
  // before the raw===null bail-out below, and specifically treats a failed
  // fetch itself as "no activity": a source that can't even be read is at
  // least as concerning to the watchdog as one that reads fine and finds
  // nothing. See evaluateReceiverSilenceRule for why this triggers on
  // absence rather than presence, unlike every other notification rule.
  evaluateReceiverSilenceRule(Array.isArray(raw?.aircraft) && raw.aircraft.length > 0);

  if (raw === null) return;

  const { updated, removed } = applyRawSnapshot(raw);

  for (const aircraft of updated) {
    // Attached directly onto the (already-mutable, freshly-normalized)
    // aircraft object before toWireAircraftList below -- wire.js spreads
    // the whole object rather than picking a fixed field list, so this
    // rides along on the existing delta for free, no new WS message needed.
    // See rules.js's own doc comment on evaluateAircraftRules for why this
    // is a live, cooldown-independent fact rather than the same throttled
    // signal the notification itself uses. Only set when non-empty --
    // almost every aircraft on almost every tick has no active alert, and
    // `"alertKinds":[]` on every one of them would be pure overhead (same
    // "omit rather than send an empty array every tick" discipline the
    // delta's own `removed` field already follows below).
    const alertKinds = evaluateAircraftRules(aircraft);
    if (alertKinds.length > 0) aircraft.alertKinds = alertKinds;
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
    // Omitted entirely on the overwhelmingly common tick where nothing was
    // dropped, rather than sent as an empty array every second to every
    // client -- hard rule 1's "send only what changed" applies to this the
    // same as to the aircraft themselves.
    ...(removed.length > 0 ? { removed } : {}),
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
  // Which aircraft actually achieved bestRangeKm -- purely for the range-
  // record UI event's click-to-select-on-the-map affordance (rules.js's
  // evaluateRangeRecordRule); the ntfy notification itself has never needed
  // this, it's always been a bare distance.
  let bestRangeAircraft = null;
  let withPos = 0;
  let withoutPos = 0;

  for (const aircraft of getTrackedAircraft()) {
    const hasPosition = typeof aircraft.lat === 'number' && typeof aircraft.lon === 'number';
    if (hasPosition) withPos += 1;
    else withoutPos += 1;

    // isRangeEligible excludes MLAT (and everything else that isn't
    // straight ADS-B) from range/antenna sampling -- see range.js. An MLAT
    // position doesn't say anything about *this* antenna's own reception
    // range, so letting it feed the range-record notification, the Stats
    // range chart, or the coverage map would inflate all three with
    // contacts this receiver never actually heard that far out.
    if (home && hasPosition && isRangeEligible(aircraft.sourceType)) {
      const km = distanceKm(home.lat, home.lon, aircraft.lat, aircraft.lon);
      if (bestRangeKm === null || km > bestRangeKm) {
        bestRangeKm = km;
        bestRangeAircraft = aircraft;
      }

      recordAntennaSample({
        homeLat: home.lat,
        homeLon: home.lon,
        lat: aircraft.lat,
        lon: aircraft.lon,
        altBaro: aircraft.altBaro,
        onGround: aircraft.onGround,
        hex: aircraft.hex,
        messages: aircraft.messages,
      });
    }

    if (aircraft.registration) {
      recordSighting(aircraft.registration, {
        typeCode: aircraft.typeCode,
        airlineIcao: resolveAirlineIcao(aircraft, airlines),
      });
    }

    // seen-flights.js caches this in memory and batches the actual SD
    // write on the same periodic flush as registrations (hard rule 5) --
    // unlike the old hasSeenFlight/markFlightSeen guard this replaced, it
    // also advances last_seen_at on every sighting, not just the first.
    if (aircraft.flight) noteFlightSeen(aircraft.flight);

    // Two independent hex trackers, feeding Stats' "Aircraft seen" vs
    // "Aircraft tracked" tiles: noteAircraftSeen is unconditional (every
    // hex, however briefly glimpsed); touchAircraftTracked only advances an
    // entry that notifications/rules.js's own first-seen delay has already
    // confirmed (a no-op otherwise) -- creating that entry stays gated
    // there, this just keeps its last_seen_at current once it exists.
    noteAircraftSeen(aircraft.hex);
    touchAircraftTracked(aircraft.hex);

    recordDailyUnique(aircraft.hex, aircraft.flight);
  }

  // The counts the Stats history charts are built from -- see
  // stats-history.js's recordTrackedCounts for why they come from here (our
  // own tracked set, the same one the map and the List panel show) rather
  // than from stats.json's own aircraft counters.
  recordTrackedCounts(withPos + withoutPos, withPos, withoutPos);

  if (bestRangeKm !== null) {
    // Rounded once, here, so the daily figure and the all-time record are
    // fed the exact same number -- they already share this one source of
    // truth (see below), and rounding them separately would be a way to
    // quietly reintroduce the "today > all time" disagreement.
    bestRangeKm = roundKm(bestRangeKm);
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
    evaluateRangeRecordRule(bestRangeKm, bestRangeAircraft);
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

// Only what the browser can't work out for itself. The aircraft count used
// to be sent from here too, and the Stats panel's live tile showed it while
// the List panel right next to it counted the browser's own set -- two
// numbers for the same question, from two different snapshots in time. The
// count is now taken client-side, from the same live set the map and the
// list are drawn from.
function broadcastStats(broadcast) {
  const { messagesPerSec } = getLatestStatsValues();
  broadcast({
    type: 'stats',
    messagesPerSec,
    maxRangeLastHourKm: getMaxRangeLastHourKm(),
  });
}

async function main() {
  const { app, broadcast, closeWebSockets } = await buildServer();

  // The on-map toast/glow feature's fourth delivery channel (alongside
  // ntfy/MQTT) -- rules.js has no idea what a WebSocket is, so this hands
  // it the one function it needs. `type: 'notification'` is its own top-
  // level WS message type, sibling to 'delta'/'stats'/'full', not folded
  // into the aircraft delta -- unlike alertKinds (which rides along on an
  // aircraft's own wire object because it's a per-aircraft *state*), this
  // is a discrete *event* with no natural aircraft-object home, and
  // receiver_silence has no aircraft at all.
  setUiEventSender((event) => broadcast({ type: 'notification', ...event }));

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
  }, DAILY_STATS_FLUSH_INTERVAL_MS);

  setInterval(() => {
    try {
      flushAntennaStatsIfDirty();
    } catch (err) {
      app.log.error(err, 'antenna stats flush failed');
    }
  }, ANTENNA_STATS_FLUSH_INTERVAL_MS);

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
    // Shared between trail history and the circling detector's own per-hex
    // window (server/src/notifications/circling-detector.js) -- same
    // "still in state.js's tracked set" definition of stale, computed once
    // rather than twice.
    const activeHexes = new Set(getTrackedAircraft().map((aircraft) => aircraft.hex));
    evictStaleTrails(activeHexes);
    evictStaleCircling(activeHexes);
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
    try {
      // Before app.close(), never after -- see server.js's closeWebSockets:
      // app.close() waits for every connection to drain, and an open
      // WebSocket never drains on its own, so this is what stops shutdown
      // hanging until systemd's 90s timeout on any restart with a browser
      // tab open.
      closeWebSockets();
    } catch (err) {
      app.log.error(err, 'websocket shutdown failed');
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
