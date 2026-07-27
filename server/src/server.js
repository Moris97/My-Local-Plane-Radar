import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
import { getTypeCounts, getAirlineCounts, getNewRegistrationsBuckets, getRegistrationsList } from './stats-registrations.js';
import { getAirlines } from './airlines-data.js';
import { isDaylight } from './daylight.js';
import { validatePort, resolvePort, setConfiguredPort } from './server-config.js';

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

  // Full list, unfiltered by range -- the point-7 table is "loaded on
  // click" and does its own client-side sorting, same as list.js's live
  // aircraft table.
  app.get('/api/stats/registrations', async () => getRegistrationsList());

  app.get('/api/airlines', async () => Object.fromEntries(getAirlines()));

  app.get('/api/trails', async () => getAllTrails());

  app.get('/api/trails/:hex', async (request) => getTrail(request.params.hex));

  app.get('/api/notifications/settings', { preHandler: requireSettingsAuth }, async () => getNotificationSettings());

  app.put('/api/notifications/settings', { preHandler: requireSettingsAuth }, async (request, reply) => {
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

  app.get('/api/notifications/ntfy-topic', { preHandler: requireSettingsAuth }, async () => ({ topic: getNtfyTopic() }));

  app.post(
    '/api/notifications/ntfy-topic/regenerate',
    { preHandler: requireSettingsAuth },
    async () => ({ topic: regenerateNtfyTopic() }),
  );

  app.get('/api/notifications/watchlist', { preHandler: requireSettingsAuth }, async () => getWatchList());

  app.post('/api/notifications/watchlist', { preHandler: requireSettingsAuth }, async (request, reply) => {
    const body = request.body ?? {};
    const error = validateWatchEntryInput(body);
    if (error) {
      return reply.code(400).send({ error });
    }
    return addWatchEntry(body);
  });

  app.delete('/api/notifications/watchlist/:id', { preHandler: requireSettingsAuth }, async (request, reply) => {
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
