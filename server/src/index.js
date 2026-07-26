import { buildServer } from './server.js';
import { createSource } from './sources/index.js';
import { applyRawSnapshot } from './state.js';
import { toWireAircraftList } from './wire.js';

const PORT = Number(process.env.MLPR_PORT ?? 1090);
const HOST = process.env.MLPR_HOST ?? '0.0.0.0';
const POLL_INTERVAL_MS = 1000;

const source = createSource();

async function pollOnce(broadcast) {
  const raw = await source.fetchSnapshot();
  if (raw === null) return;

  const updated = applyRawSnapshot(raw);
  if (updated.length === 0) return;

  broadcast({
    type: 'delta',
    now: Date.now() / 1000,
    updated: toWireAircraftList(updated),
  });
}

async function main() {
  const { app, broadcast } = await buildServer();

  setInterval(() => {
    pollOnce(broadcast).catch((err) => app.log.error(err, 'poll failed'));
  }, POLL_INTERVAL_MS);

  await app.listen({ port: PORT, host: HOST });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
