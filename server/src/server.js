import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { WebSocketServer } from 'ws';
import { getTrackedAircraft } from './state.js';
import { toWireAircraftList } from './wire.js';
import { getEffectiveHome, setManualHome, clearManualHome } from './home.js';
import { getHistory } from './stats-history.js';

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

  function settingsPayload() {
    const home = getEffectiveHome();
    return {
      homeLat: home?.lat ?? null,
      homeLon: home?.lon ?? null,
      homeSource: home?.source ?? null,
    };
  }

  app.get('/api/settings', async () => settingsPayload());

  app.put('/api/settings', async (request, reply) => {
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

  app.get('/api/stats/history', async () => getHistory());

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
