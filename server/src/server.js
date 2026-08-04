import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { WebSocketServer } from 'ws';
import { getTrackedAircraft } from './state.js';
import { toWireAircraftList } from './wire.js';
import { getEffectiveHome, setManualHome, clearManualHome } from './home.js';
import { getNotificationSettings, updateNotificationSettings, getNtfyTopic, regenerateNtfyTopic, getSmartHomeSettings, updateSmartHomeSettings } from './notifications/settings.js';
import { getWatchList, addWatchEntry, removeWatchEntry, validateWatchEntryInput } from './notifications/watchlist.js';
import { reconfigureSmartHome, testSmartHomeConnection, publishSmartHomeEvent, isSmartHomeConnected } from './notifications/smart-home.js';
import {
  isPasswordSet, verifyPassword, setPassword, removePassword, issueToken, isValidToken,
  isLockedOut, recordFailedAttempt, recordSuccessfulAttempt,
} from './settings-auth.js';
import { exportConfig, importConfig } from './config-backup.js';
import { getTrail, getAllTrails } from './trail-history.js';
import { getStatsHistoryForRange, granularityFor } from './stats-query.js';
import { queryTable } from './stats-table.js';
import { rangeStartMs } from './time-buckets.js';
import {
  getTypeCounts,
  getAirlineCounts,
  getNewRegistrationsBuckets,
  getNewRegistrationsBucketsByKey,
  queryRegistrations,
} from './stats-registrations.js';
import { getSeenFlightsCount } from './seen-flights.js';
import { getAircraftSeenCount } from './aircraft-seen.js';
import { getAircraftTrackedCount } from './aircraft-tracked.js';
import { getAirlines } from './airlines-data.js';
import { isDaylight } from './daylight.js';
import { validatePort, resolvePort, setConfiguredPort } from './server-config.js';
import { getAllAirlinesSummary } from './db.js';
import { getAllTimeMaxRangeKm, resetAllTimeMaxRangeKm, squawkMeaningFor } from './notifications/rules.js';
import { ALTITUDE_BANDS, getAltitudeBandStats, getSectorStats, getLatestSignal, clearAntennaStats } from './antenna-stats.js';
import { destinationPoint, distanceKm, roundKm } from './range.js';
import { clearRangeSamples } from './stats-history.js';

const VALID_STATS_RANGES = new Set(['24h', '7d', '31d', '1y', 'all']);

function parseStatsRange(request) {
  const range = request.query?.range;
  return VALID_STATS_RANGES.has(range) ? range : 'all';
}

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

const publicDir = join(__dirname, '..', '..', 'public');
const maplibreDistDir = dirname(require.resolve('maplibre-gl/dist/maplibre-gl.js'));
const mapDataDir = join(__dirname, '..', '..', 'data', 'naturalearth');
// Deliberately outside publicDir -- fastifyStatic above serves all of
// public/ unconditionally, so a dev-only page can't live there without a
// second, NODE_ENV-gated mechanism (see below).
const devDir = join(__dirname, '..', '..', 'dev');
const appVersion = require('../../package.json').version;

// Mirrors public/js/stats.js's AIRLINES_COLUMNS: same fields, same
// resolved-name-not-ICAO rule as the registrations table.
const AIRLINES_TABLE_SPEC = (airlineNameFor) => ({
  searchFields: [(r) => r.airlineIcao, (r) => airlineNameFor(r.airlineIcao)],
  sortFields: {
    name: (r) => airlineNameFor(r.airlineIcao),
    airlineIcao: (r) => r.airlineIcao,
    registrationsCount: (r) => r.registrationsCount,
    totalTimesSeen: (r) => r.totalTimesSeen,
    firstSeenAt: (r) => r.firstSeenAt,
    lastSeenAt: (r) => r.lastSeenAt,
  },
  defaultSort: { key: 'registrationsCount', dir: 'desc' },
});

export async function buildServer({ logger = true } = {}) {
  const app = Fastify({ logger });

  // No reason for this app to ever be framed by another site, and no
  // reason for a browser to guess a response's type past what we already
  // declare -- both cheap, no-downside hardening, applied to every
  // response rather than picked route by route.
  app.addHook('onSend', (request, reply, payload, done) => {
    reply.header('X-Frame-Options', 'DENY');
    reply.header('X-Content-Type-Options', 'nosniff');
    done(null, payload);
  });

  await app.register(fastifyStatic, {
    root: publicDir,
  });

  await app.register(fastifyStatic, {
    root: maplibreDistDir,
    prefix: '/vendor/maplibre-gl/',
    decorateReply: false,
  });

  await app.register(fastifyStatic, {
    root: mapDataDir,
    prefix: '/mapdata/',
    decorateReply: false,
  });

  // Icon dev/test tool -- never reachable in production. Registering the
  // static prefix itself only when NODE_ENV !== 'production' (rather than
  // relying on the route alone) means /dev/icons-client.js also 404s in
  // production, not just the page.
  if (process.env.NODE_ENV !== 'production') {
    await app.register(fastifyStatic, {
      root: devDir,
      prefix: '/dev/',
      decorateReply: false,
    });
    app.get('/dev/icons', async (request, reply) => {
      reply.type('text/html').send(await readFile(join(devDir, 'icons.html'), 'utf8'));
    });
    app.get('/dev/icons-map', async (request, reply) => {
      reply.type('text/html').send(await readFile(join(devDir, 'icons-map.html'), 'utf8'));
    });
    app.get('/dev/icon-types', async (request, reply) => {
      reply.type('text/html').send(await readFile(join(devDir, 'icon-types.html'), 'utf8'));
    });
  }

  // Icon verification against REAL receiver data -- deliberately NOT
  // gated behind the NODE_ENV check above (it's the one dev/ page meant
  // to be used in production: it's only useful once a receiver has
  // actually accumulated real registrations to classify, which a dev
  // machine never has). Its client script lives under public/js/ (always
  // served, no gate) rather than dev/ (gated) for exactly this reason --
  // only the HTML shell is read from dev/ here, via readFile rather than
  // the gated static mount.
  app.get('/dev/icon_verify', async (request, reply) => {
    reply.type('text/html').send(await readFile(join(devDir, 'icon_verify.html'), 'utf8'));
  });

  // Same reasoning as /dev/icon_verify above: deliberately NOT gated by
  // NODE_ENV -- this is a tool for testing a real, already-configured
  // smart-home connection (real broker, real Home Assistant automations),
  // which only exists on a real deployment, not a dev machine. Its client
  // script lives under public/js/ (always served) for the same reason.
  app.get('/dev/smart-home-test', async (request, reply) => {
    reply.type('text/html').send(await readFile(join(devDir, 'smart-home-test.html'), 'utf8'));
  });

  async function requireSettingsAuth(request, reply) {
    if (!isPasswordSet()) return;
    if (!isValidToken(request.headers['x-mlpr-settings-token'])) {
      reply.code(401).send({ error: 'Settings are password protected' });
    }
  }

  app.get('/api/settings-auth/status', async () => ({ passwordSet: isPasswordSet() }));

  // Both routes below call verifyPassword() with attacker-suppliable input
  // and unlimited attempts would make the password guessable by brute
  // force -- guarded by the same per-IP lockout (settings-auth.js's
  // isLockedOut/recordFailedAttempt/recordSuccessfulAttempt), checked
  // before verifyPassword() runs so a locked-out client can't even spend
  // a guess while waiting out the lockout.
  app.post('/api/settings-auth/login', async (request, reply) => {
    if (isLockedOut(request.ip)) {
      return reply.code(429).send({ error: 'Too many failed attempts, try again later' });
    }
    const { password } = request.body ?? {};
    if (!verifyPassword(password)) {
      recordFailedAttempt(request.ip);
      return reply.code(401).send({ error: 'Incorrect password' });
    }
    recordSuccessfulAttempt(request.ip);
    return { token: issueToken() };
  });

  app.post('/api/settings-auth/password', async (request, reply) => {
    const { newPassword, currentPassword } = request.body ?? {};

    if (isPasswordSet()) {
      if (isLockedOut(request.ip)) {
        return reply.code(429).send({ error: 'Too many failed attempts, try again later' });
      }
      if (!verifyPassword(currentPassword)) {
        recordFailedAttempt(request.ip);
        return reply.code(401).send({ error: 'Current password is incorrect' });
      }
      recordSuccessfulAttempt(request.ip);
    }

    if (!newPassword) {
      removePassword();
      return { passwordSet: false };
    }

    if (typeof newPassword !== 'string' || newPassword.length < 4) {
      return reply.code(400).send({ error: 'Password must be at least 4 characters' });
    }

    setPassword(newPassword);
    return { passwordSet: true, token: issueToken() };
  });

  function settingsPayload() {
    const home = getEffectiveHome();
    return {
      homeLat: home?.lat ?? null,
      homeLon: home?.lon ?? null,
      homeSource: home?.source ?? null,
    };
  }

  app.get('/api/settings', { preHandler: requireSettingsAuth }, async () => settingsPayload());

  // Answers with how far the *effective* home actually moved, so the UI can
  // point out that everything measured from the old position (antenna
  // coverage, the all-time range record) no longer describes where the
  // receiver is. Deliberately reports rather than acts: a small correction
  // of the pin is routine and must not silently destroy months of coverage
  // data, so clearing stays an explicit choice -- POST /api/stats/antenna/
  // reset below. Clearing a manual override counts as a move too, since the
  // effective home falls back to receiver.json's own position.
  function homeMovedKm(previous) {
    const current = getEffectiveHome();
    if (!previous || !current) return null;
    return roundKm(distanceKm(previous.lat, previous.lon, current.lat, current.lon));
  }

  app.put('/api/settings', { preHandler: requireSettingsAuth }, async (request, reply) => {
    const body = request.body ?? {};
    const previousHome = getEffectiveHome();

    if (body.homeLat === null && body.homeLon === null) {
      clearManualHome();
      return { ...settingsPayload(), homeMovedKm: homeMovedKm(previousHome) };
    }

    if (typeof body.homeLat !== 'number' || typeof body.homeLon !== 'number') {
      return reply.code(400).send({ error: 'homeLat and homeLon must both be numbers, or both null to clear' });
    }
    if (body.homeLat < -90 || body.homeLat > 90 || body.homeLon < -180 || body.homeLon > 180) {
      return reply.code(400).send({ error: 'homeLat must be within -90..90 and homeLon within -180..180' });
    }

    setManualHome(body.homeLat, body.homeLon);
    return { ...settingsPayload(), homeMovedKm: homeMovedKm(previousHome) };
  });

  // Deliberately NOT behind requireSettingsAuth: this is what the automatic
  // map theme polls, so every browser needs it whether or not it's logged
  // in to Settings. It exposes only a boolean, never the receiver's
  // coordinates. `null` means "no home location known", which the client
  // treats as "fall back to the OS light/dark preference".
  app.get('/api/daylight', async () => {
    const home = getEffectiveHome();
    if (!home) return { isDaylight: null };
    return { isDaylight: isDaylight(home.lat, home.lon) };
  });

  // Read from package.json rather than kept in a second place that could
  // disagree with it. Ungated and deliberately so: the credits panel shows
  // it to every browser, and a version number is not a secret.
  app.get('/api/version', async () => ({ version: appVersion }));

  app.get('/api/server/port', { preHandler: requireSettingsAuth }, async () => {
    const { port, source } = resolvePort();
    return { port, source };
  });

  app.put('/api/server/port', { preHandler: requireSettingsAuth }, async (request, reply) => {
    const result = validatePort(request.body?.port);
    if (!result.ok) return reply.code(400).send({ error: result.error });

    setConfiguredPort(result.port);
    // Saved, but the running server keeps listening on its current port --
    // see the comment in index.js on why we don't self-restart.
    const { port, source } = resolvePort();
    return { port, source, restartRequired: true };
  });

  // A full config backup/restore (config-backup.js) -- gated the same as
  // /api/settings and /api/server/port even though it also bundles things
  // that normally aren't gated on their own (notification settings, watch
  // list): the export is one payload containing the password hash, home
  // location, and smart-home broker credentials alongside those, so the
  // combined response has to be protected at the level of its most
  // sensitive content, not its least.
  app.get('/api/settings/export', { preHandler: requireSettingsAuth }, async () => exportConfig());

  app.post('/api/settings/import', { preHandler: requireSettingsAuth }, async (request, reply) => {
    const result = importConfig(request.body);
    if (!result.ok) return reply.code(400).send({ error: result.error });
    // Any of the imported keys could be the smart-home settings blob --
    // same "apply immediately, no restart needed" behavior the smart-home
    // PUT route already has, just reached from a different entry point.
    reconfigureSmartHome();
    return result;
  });

  app.get('/api/stats/history', async (request) => getStatsHistoryForRange(parseStatsRange(request)));

  app.get('/api/stats/types', async (request) => {
    const range = parseStatsRange(request);
    return getTypeCounts(rangeStartMs(range));
  });

  app.get('/api/stats/airlines', async (request) => {
    const range = parseStatsRange(request);
    return getAirlineCounts(rangeStartMs(range));
  });

  app.get('/api/stats/new-registrations', async (request) => {
    const range = parseStatsRange(request);
    return getNewRegistrationsBuckets(rangeStartMs(range), granularityFor(range));
  });

  // Powers the doughnut<->line toggle on the "most common type/airline"
  // charts: `keys` is the doughnut's own already-fetched top-N list (comma
  // separated), so this only ever computes a trend for types/airlines
  // already known to be worth showing, never a long tail of one-offs.
  const TREND_FIELD_EXTRACTORS = {
    type: (e) => e.typeCode,
    airline: (e) => e.airlineIcao,
  };
  app.get('/api/stats/registrations-trend', async (request, reply) => {
    const field = request.query?.field;
    const extractor = TREND_FIELD_EXTRACTORS[field];
    if (!extractor) {
      return reply.code(400).send({ error: 'field must be "type" or "airline"' });
    }
    const range = parseStatsRange(request);
    const keys = String(request.query?.keys ?? '')
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean);
    if (keys.length === 0) return [];
    return getNewRegistrationsBucketsByKey(rangeStartMs(range), granularityFor(range), extractor, keys);
  });

  // Both Stats tables are searched, sorted and paged *server-side* and
  // answer `{ rows, total, page, pageSize, totalPages, sort, dir }`. They
  // used to return the whole table and let the browser do all three, which
  // meant the pagination control was real while the paging wasn't: an
  // install's entire registration history crossed the network, and sat in
  // both the Pi's and the phone's memory, to show twenty rows.
  //
  // Airline names are resolved here rather than by the client because
  // that's what the column shows, so it's what search and sort have to
  // work on. `pageSize=0` is the CSV export's own request for the full
  // current view -- a deliberate, rare download, not the default path.
  const airlineNameFor = (icao) => getAirlines().get(icao)?.name ?? icao;

  app.get('/api/stats/registrations', async (request) => queryRegistrations(request.query ?? {}, airlineNameFor));

  app.get('/api/stats/all-airlines', async (request) =>
    queryTable(getAllAirlinesSummary(), AIRLINES_TABLE_SPEC(airlineNameFor), request.query ?? {}));

  // One summary for whichever range the Stats panel's own selector is
  // currently on (same 24h/7d/31d/1y/all as every other stats endpoint,
  // via the shared parseStatsRange/VALID_STATS_RANGES) -- replaces the old
  // period=today|all split, which only ever answered two fixed windows and
  // left every range in between (7d/31d/1y) with nothing to show here at
  // all.
  //
  // 'all' keeps reading the notification engine's own getAllTimeMaxRangeKm
  // rather than deriving a max from daily_stats buckets like every other
  // range does below -- that value already comes from the exact same
  // self-computed, MLAT-excluded per-tick sampling as daily_stats itself
  // (see recordRangeAndRegistrationSightings), so re-deriving it a second,
  // slightly different way here would risk exactly the kind of "two
  // independently-computed range figures disagree" bug that reusing a
  // single source of truth already fixed once before.
  app.get('/api/stats/summary', async (request) => {
    const range = parseStatsRange(request);
    const sinceMs = rangeStartMs(range);
    const maxRangeKm = range === 'all'
      ? getAllTimeMaxRangeKm()
      : Math.max(0, ...getStatsHistoryForRange(range).map((bucket) => bucket.maxRangeKm ?? 0));

    return {
      // Two deliberately different aircraft counts, not one: aircraftSeen
      // is every hex the receiver ever glimpsed at all (aircraft-seen.js,
      // no gate); aircraftTracked is the subset confirmed by the
      // first-seen notification's own ~3s/second-look delay
      // (aircraft-tracked.js) -- named and shown separately so the two
      // numbers read as "everything glimpsed" vs "solid contacts" instead
      // of one ambiguous "how many aircraft" tile.
      aircraftSeenCount: getAircraftSeenCount(sinceMs),
      aircraftTrackedCount: getAircraftTrackedCount(sinceMs),
      uniqueFlightsCount: getSeenFlightsCount(sinceMs),
      maxRangeKm,
      topTypes: getTypeCounts(sinceMs),
      topAirlines: getAirlineCounts(sinceMs),
    };
  });

  app.get('/api/stats/antenna', async () => {
    const { signalDbfs, peakSignalDbfs } = getLatestSignal();
    return {
      altitudeBands: getAltitudeBandStats(),
      sectors: getSectorStats(),
      signalDbfs,
      peakSignalDbfs,
    };
  });

  function closedRing(points) {
    const ring = points.map((p) => [p.lon, p.lat]);
    ring.push(ring[0]); // GeoJSON polygons must be a closed ring.
    return ring;
  }

  // Gated the same as /api/settings: the polygon this returns is derived
  // from the receiver's exact home coordinates (each vertex is home +
  // bearing + distance), so it's just as revealing as the home marker --
  // same access control, not a special case that bypasses it.
  // Everything measured against a home location: the per-band/sector
  // coverage cells, the all-time range record, and the rolling per-minute
  // range samples feeding today's figures. All three are distances and
  // bearings *from* a specific point, so they describe the old position
  // after the receiver moves and nothing else would ever correct them --
  // the all-time record in particular can otherwise never be beaten again
  // from a worse location, silencing its notification for good.
  //
  // Deliberately does NOT touch daily_stats: those rows are a historical
  // log of what was true on each day, not a current claim about where the
  // antenna reaches. Same auth gate as the coverage endpoint, since this
  // is a server-level, irreversible action.
  app.post('/api/stats/antenna/reset', { preHandler: requireSettingsAuth }, async () => {
    clearAntennaStats();
    resetAllTimeMaxRangeKm();
    clearRangeSamples();
    return { ok: true };
  });

  app.get('/api/stats/antenna/coverage', { preHandler: requireSettingsAuth }, async (request, reply) => {
    const home = getEffectiveHome();
    if (!home) return { fillPolygon: null, maxPolygon: null };

    const bandParam = request.query?.band;
    let bandIndex = null;
    if (bandParam !== undefined && bandParam !== 'all') {
      const parsed = Number(bandParam);
      if (!Number.isInteger(parsed) || parsed < 0 || parsed >= ALTITUDE_BANDS.length) {
        return reply.code(400).send({ error: `band must be "all" or an integer 0..${ALTITUDE_BANDS.length - 1}` });
      }
      bandIndex = parsed;
    }

    const sectors = getSectorStats(bandIndex);
    return {
      // "Fill" (the primary shape) uses the outlier-resistant top-5 average;
      // "max" is the honest single best-ever contact per direction, meant
      // to be drawn as a thin outline around the fill rather than its own
      // filled shape -- see CLAUDE.md for why (VRS's/tar1090's plots are
      // exactly this max value alone, and that's what makes them spiky).
      fillPolygon: closedRing(sectors.map((s) => destinationPoint(home.lat, home.lon, s.bearingDeg, s.topAvgRangeKm))),
      maxPolygon: closedRing(sectors.map((s) => destinationPoint(home.lat, home.lon, s.bearingDeg, s.maxRangeKm))),
    };
  });

  app.get('/api/airlines', async () => Object.fromEntries(getAirlines()));

  app.get('/api/trails', async () => getAllTrails());

  app.get('/api/trails/:hex', async (request) => getTrail(request.params.hex));

  app.get('/api/notifications/settings', async () => getNotificationSettings());

  app.put('/api/notifications/settings', async (request, reply) => {
    const body = request.body ?? {};
    const patch = {};

    // watchedEnabled was missing from this list entirely -- the Notifications
    // tab's "Watched aircraft" checkbox has called PUT with it since the
    // toggle was added (2026-08-01), but every value silently never reached
    // updateNotificationSettings, so the checkbox had no effect. Found
    // 2026-08-02 while adding receiverSilenceEnabled to this same list.
    for (const key of ['squawkEnabled', 'firstSeenEnabled', 'rangeRecordEnabled', 'watchedEnabled', 'receiverSilenceEnabled']) {
      if (key in body) {
        if (typeof body[key] !== 'boolean') {
          return reply.code(400).send({ error: `${key} must be a boolean` });
        }
        patch[key] = body[key];
      }
    }

    if ('squawkCodes' in body) {
      if (typeof body.squawkCodes !== 'object' || body.squawkCodes === null) {
        return reply.code(400).send({ error: 'squawkCodes must be an object of code -> boolean' });
      }
      for (const value of Object.values(body.squawkCodes)) {
        if (typeof value !== 'boolean') {
          return reply.code(400).send({ error: 'squawkCodes values must be booleans' });
        }
      }
      patch.squawkCodes = body.squawkCodes;
    }

    return updateNotificationSettings(patch);
  });

  app.get('/api/notifications/ntfy-topic', async () => ({ topic: getNtfyTopic() }));

  app.post('/api/notifications/ntfy-topic/regenerate', async () => ({ topic: regenerateNtfyTopic() }));

  app.get('/api/notifications/watchlist', async () => getWatchList());

  app.post('/api/notifications/watchlist', async (request, reply) => {
    const body = request.body ?? {};
    const error = validateWatchEntryInput(body);
    if (error) {
      return reply.code(400).send({ error });
    }
    return addWatchEntry(body);
  });

  app.delete('/api/notifications/watchlist/:id', async (request, reply) => {
    const removed = removeWatchEntry(request.params.id);
    if (!removed) {
      return reply.code(404).send({ error: 'No watch entry with that id' });
    }
    return { removed: true };
  });

  // Smart-home (MQTT) delivery -- gated behind requireSettingsAuth, same as
  // /api/settings and /api/server/port, unlike the rest of this
  // Notifications-tab-adjacent config above (ntfy topic, watch list):
  // broker credentials are a real infrastructure secret, a different kind
  // of sensitive than a random ntfy topic string. Deliberate decision, not
  // an inconsistency.
  app.get('/api/notifications/smart-home', { preHandler: requireSettingsAuth }, async () => ({
    ...getSmartHomeSettings(),
    // Runtime state, not a saved setting -- lets the UI show "enabled but
    // not currently connected" instead of just echoing back the toggle.
    connected: isSmartHomeConnected(),
  }));

  app.put('/api/notifications/smart-home', { preHandler: requireSettingsAuth }, async (request, reply) => {
    const body = request.body ?? {};
    const patch = {};

    if ('enabled' in body) {
      if (typeof body.enabled !== 'boolean') {
        return reply.code(400).send({ error: 'enabled must be a boolean' });
      }
      patch.enabled = body.enabled;
    }
    for (const key of ['brokerUrl', 'username', 'password', 'topicPrefix']) {
      if (key in body) {
        if (typeof body[key] !== 'string') {
          return reply.code(400).send({ error: `${key} must be a string` });
        }
        patch[key] = body[key];
      }
    }
    if (patch.brokerUrl) {
      try {
        const parsed = new URL(patch.brokerUrl);
        if (parsed.protocol !== 'mqtt:' && parsed.protocol !== 'mqtts:') {
          return reply.code(400).send({ error: 'brokerUrl must start with mqtt:// or mqtts://' });
        }
      } catch {
        return reply.code(400).send({ error: 'brokerUrl is not a valid URL' });
      }
    }

    const next = updateSmartHomeSettings(patch);
    reconfigureSmartHome(); // applies immediately, no restart needed
    return next;
  });

  // Opens a separate, temporary connection using whatever's in the
  // request body (not necessarily saved yet) -- lets broker credentials be
  // verified from the Settings form before committing them. Falls back to
  // the currently-saved settings if the body is empty (e.g. "test" clicked
  // right after a page reload, before the form has been touched).
  app.post('/api/notifications/smart-home/test', { preHandler: requireSettingsAuth }, async (request) => {
    const body = request.body ?? {};
    const settings = getSmartHomeSettings();
    return testSmartHomeConnection({
      brokerUrl: body.brokerUrl ?? settings.brokerUrl,
      username: body.username ?? settings.username,
      password: body.password ?? settings.password,
    });
  });

  // Fires a real event through the REAL persistent connection (unlike
  // /test above, which opens its own temporary one) -- lets a user verify
  // their Home Assistant automations without waiting for a genuine
  // first-seen/watch-list match. See /dev/smart-home-test, which is the
  // one and only caller of this in practice.
  // Must list every reason rules.js can actually publish, or the one event
  // type left out becomes the one nobody can test -- which is exactly what
  // happened to 'squawk' when it was added as a third smart-home event
  // (2026-08-01) and this set wasn't updated with it.
  const VALID_TEST_EVENT_REASONS = new Set(['first_seen', 'watchlist', 'squawk']);
  app.post('/api/notifications/smart-home/send-test-event', { preHandler: requireSettingsAuth }, async (request, reply) => {
    const body = request.body ?? {};
    if (!VALID_TEST_EVENT_REASONS.has(body.reason)) {
      return reply.code(400).send({ error: 'reason must be "first_seen", "watchlist" or "squawk"' });
    }
    const aircraft = body.aircraft ?? {};
    if (!aircraft.hex) {
      return reply.code(400).send({ error: 'aircraft.hex is required' });
    }

    // Derived here, not taken from the request: the test event should carry
    // the same meaning the real rule would send for that code, and that
    // mapping belongs to rules.js.
    const squawkMeaning = body.reason === 'squawk' ? squawkMeaningFor(aircraft.squawk) : undefined;
    const sent = publishSmartHomeEvent({ reason: body.reason, aircraft, matchedEntry: body.matchedEntry, squawkMeaning });
    return { sent, enabled: getSmartHomeSettings().enabled, connected: isSmartHomeConnected() };
  });

  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set();

  app.server.on('upgrade', (request, socket, head) => {
    const { pathname } = new URL(request.url, `http://${request.headers.host}`);

    if (pathname !== '/ws') {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      clients.add(ws);
      ws.on('close', () => clients.delete(ws));
      ws.send(JSON.stringify({
        type: 'full',
        now: Date.now() / 1000,
        aircraft: toWireAircraftList(getTrackedAircraft()),
      }));
    });
  });

  function broadcast(payload) {
    const message = JSON.stringify(payload);
    for (const ws of clients) {
      if (ws.readyState === ws.OPEN) {
        ws.send(message);
      }
    }
  }

  // Must be called before app.close() on shutdown. An upgraded WebSocket is
  // still one of the HTTP server's own connections, and it never ends on its
  // own -- so app.close(), which waits for every connection to drain, waited
  // forever whenever any browser tab was open. In practice that meant
  // `systemctl restart` hung until systemd's TimeoutStopSec (90s by default)
  // gave up and SIGKILLed, on every restart and every reboot with a tab
  // open. (Data was never at risk: index.js does all its flushes before
  // app.close(). It was purely a 90-second stall.) Found 2026-08-01 by
  // noticing test servers that logged "shutting down" and then just sat
  // there; reproduced deterministically -- no WS client, exits in ~200ms;
  // one WS client, never exits.
  //
  // terminate() rather than close(): close() starts a closing handshake and
  // waits for the peer to answer, which an unresponsive client may never do
  // -- reintroducing the same hang in a smaller form. We are exiting anyway,
  // and app.js's own WebSocket 'close' handler already reconnects a second
  // later, so dropping the socket outright is both safe and what a restart
  // wants.
  function closeWebSockets() {
    for (const ws of clients) {
      ws.terminate();
    }
    clients.clear();
    wss.close();
  }

  return { app, broadcast, closeWebSockets };
}
