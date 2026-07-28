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
import { getNotificationSettings, updateNotificationSettings, getNtfyTopic, regenerateNtfyTopic } from './notifications/settings.js';
import { getWatchList, addWatchEntry, removeWatchEntry, validateWatchEntryInput } from './notifications/watchlist.js';
import { isPasswordSet, verifyPassword, setPassword, removePassword, issueToken, isValidToken } from './settings-auth.js';
import { getTrail, getAllTrails } from './trail-history.js';
import { getStatsHistoryForRange } from './stats-query.js';
import { rangeStartMs, bucketGranularityForRange } from './time-buckets.js';
import {
  getTypeCounts,
  getAirlineCounts,
  getNewRegistrationsBuckets,
  getNewRegistrationsBucketsByKey,
  getNewRegistrationsCount,
  getRegistrationsList,
} from './stats-registrations.js';
import { getAirlines } from './airlines-data.js';
import { isDaylight } from './daylight.js';
import { validatePort, resolvePort, setConfiguredPort } from './server-config.js';
import { getTodayStartMs, getDailyUniqueCounts, getRangeSummary } from './stats-history.js';
import { getSeenAircraftCount, getSeenFlightsCount, getRegistrationsCount, getAllAirlinesSummary } from './db.js';
import { getAllTimeMaxRangeKm } from './notifications/rules.js';
import { ALTITUDE_BANDS, getAltitudeBandStats, getSectorStats, getLatestSignal } from './antenna-stats.js';
import { destinationPoint } from './range.js';

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

export async function buildServer() {
  const app = Fastify({ logger: true });

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
  }

  async function requireSettingsAuth(request, reply) {
    if (!isPasswordSet()) return;
    if (!isValidToken(request.headers['x-mlpr-settings-token'])) {
      reply.code(401).send({ error: 'Settings are password protected' });
    }
  }

  app.get('/api/settings-auth/status', async () => ({ passwordSet: isPasswordSet() }));

  app.post('/api/settings-auth/login', async (request, reply) => {
    const { password } = request.body ?? {};
    if (!verifyPassword(password)) {
      return reply.code(401).send({ error: 'Incorrect password' });
    }
    return { token: issueToken() };
  });

  app.post('/api/settings-auth/password', async (request, reply) => {
    const { newPassword, currentPassword } = request.body ?? {};

    if (isPasswordSet() && !verifyPassword(currentPassword)) {
      return reply.code(401).send({ error: 'Current password is incorrect' });
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

  app.put('/api/settings', { preHandler: requireSettingsAuth }, async (request, reply) => {
    const body = request.body ?? {};

    if (body.homeLat === null && body.homeLon === null) {
      clearManualHome();
      return settingsPayload();
    }

    if (typeof body.homeLat !== 'number' || typeof body.homeLon !== 'number') {
      return reply.code(400).send({ error: 'homeLat and homeLon must both be numbers, or both null to clear' });
    }
    if (body.homeLat < -90 || body.homeLat > 90 || body.homeLon < -180 || body.homeLon > 180) {
      return reply.code(400).send({ error: 'homeLat must be within -90..90 and homeLon within -180..180' });
    }

    setManualHome(body.homeLat, body.homeLon);
    return settingsPayload();
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
    return getNewRegistrationsBuckets(rangeStartMs(range), bucketGranularityForRange(range));
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
    return getNewRegistrationsBucketsByKey(rangeStartMs(range), bucketGranularityForRange(range), extractor, keys);
  });

  // Full list, unfiltered by range -- the point-7 table is "loaded on
  // click" and does its own client-side sorting, same as list.js's live
  // aircraft table.
  app.get('/api/stats/registrations', async () => getRegistrationsList());

  // Same pattern as /api/stats/registrations above, but the aggregated
  // per-airline view -- see db.js's getAllAirlinesSummary.
  app.get('/api/stats/all-airlines', async () => getAllAirlinesSummary());

  const VALID_SUMMARY_PERIODS = new Set(['today', 'all']);
  app.get('/api/stats/summary', async (request, reply) => {
    const period = request.query?.period;
    if (!VALID_SUMMARY_PERIODS.has(period)) {
      return reply.code(400).send({ error: 'period must be "today" or "all"' });
    }

    const sinceMs = period === 'today' ? getTodayStartMs() : 0;
    const uniqueCounts = period === 'today'
      ? getDailyUniqueCounts()
      : { uniqueAircraftCount: getSeenAircraftCount(), uniqueFlightsCount: getSeenFlightsCount() };

    return {
      uniqueAircraftCount: uniqueCounts.uniqueAircraftCount,
      uniqueFlightsCount: uniqueCounts.uniqueFlightsCount,
      newRegistrationsCount: getNewRegistrationsCount(sinceMs),
      registrationsCount: period === 'today' ? null : getRegistrationsCount(),
      maxRangeKm: period === 'today' ? getRangeSummary().maxRangeKm : getAllTimeMaxRangeKm(),
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

    for (const key of ['squawkEnabled', 'firstSeenEnabled', 'rangeRecordEnabled']) {
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

  return { app, broadcast };
}
