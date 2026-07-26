import { buildServer } from './server.js';
import { createSource } from './sources/index.js';
import { applyRawSnapshot, getTrackedAircraft } from './state.js';
import { toWireAircraftList } from './wire.js';
import { setAutoDetectedHome } from './home.js';
import { ingestStats, getDailyAccumulator, getLatestStatsValues } from './stats-history.js';
import { upsertDailyStats } from './db.js';

const PORT = Number(process.env.MLPR_PORT ?? 1090);
const HOST = process.env.MLPR_HOST ?? '0.0.0.0';
const POLL_INTERVAL_MS = 1000;
const STATS_POLL_INTERVAL_MS = 15000;
const STATS_BROADCAST_INTERVAL_MS = 5000;
const DAILY_STATS_FLUSH_INTERVAL_MS = 45000;

const source = createSource();

async function pollOnce(broadcast) {
  const raw = await source.fetchSnapshot();
  if (raw === null) return;

  const updated = applyRawSnapshot(raw);

  broadcast({
    type: 'delta',
    now: Date.now() / 1000,
    updated: toWireAircraftList(updated),
  });
}

async function pollStats() {
  const stats = await source.fetchStats();
  if (stats === null) return;
  ingestStats(stats);
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
  upsertDailyStats(accumulator.date, {
    maxAircraft: accumulator.maxAircraft,
    totalMessages: accumulator.totalMessages,
    maxRangeKm: accumulator.maxRangeKm,
  });
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

  await app.listen({ port: PORT, host: HOST });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
