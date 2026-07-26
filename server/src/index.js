import { buildServer } from './server.js';
import { createSource } from './sources/index.js';
import { applyRawSnapshot, getTrackedAircraft } from './state.js';
import { toWireAircraftList } from './wire.js';
import { setAutoDetectedHome } from './home.js';
import { ingestStats, getDailyAccumulator, getLatestStatsValues } from './stats-history.js';
import { upsertDailyStats } from './db.js';
import { evaluateAircraftRules, evaluateRangeRecordRule } from './notifications/rules.js';
import { pruneCooldowns } from './notifications/cooldown.js';

const PORT = Number(process.env.MLPR_PORT ?? 1090);
const HOST = process.env.MLPR_HOST ?? '0.0.0.0';
const POLL_INTERVAL_MS = 1000;
const STATS_POLL_INTERVAL_MS = 15000;
const STATS_BROADCAST_INTERVAL_MS = 5000;
const DAILY_STATS_FLUSH_INTERVAL_MS = 45000;
const COOLDOWN_PRUNE_INTERVAL_MS = 60 * 60 * 1000;

const source = createSource();

async function pollOnce(broadcast) {
  const raw = await source.fetchSnapshot();
  if (raw === null) return;

  const updated = applyRawSnapshot(raw);

  for (const aircraft of updated) {
    evaluateAircraftRules(aircraft);
  }

  broadcast({
    type: 'delta',
    now: Date.now() / 1000,
    updated: toWireAircraftList(updated),
  });
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

  setInterval(() => pruneCooldowns(), COOLDOWN_PRUNE_INTERVAL_MS);

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

  await app.listen({ port: PORT, host: HOST });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
