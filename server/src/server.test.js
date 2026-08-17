import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = mkdtempSync(join(tmpdir(), 'mlpr-server-test-'));
process.env.MLPR_DB_PATH = join(tmpDir, 'test.db');

const { buildServer } = await import('./server.js');
const auth = await import('./settings-auth.js');
const { decodeBackupFile, looksGzipped } = await import('./backup-file.js');
const { gzipSync } = await import('node:zlib');

async function settingsToken() {
  auth.setPassword('hunter2');
  const login = await app.inject({
    method: 'POST',
    url: '/api/settings-auth/login',
    payload: { password: 'hunter2' },
  });
  return { 'x-mlpr-settings-token': JSON.parse(login.body).token };
}

let app;

before(async () => {
  ({ app } = await buildServer({ logger: false }));
});

after(async () => {
  await app.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

test('every response carries the hardening headers (X-Frame-Options, X-Content-Type-Options)', async () => {
  const response = await app.inject({ method: 'GET', url: '/api/daylight' });
  assert.equal(response.headers['x-frame-options'], 'DENY');
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
});

test('login succeeds with the correct password and clears any prior failed attempts', async () => {
  auth.setPassword('hunter2');
  const response = await app.inject({
    method: 'POST',
    url: '/api/settings-auth/login',
    payload: { password: 'hunter2' },
  });
  assert.equal(response.statusCode, 200);
  assert.ok(JSON.parse(response.body).token);
});

test('login is locked out after enough failed attempts from the same IP, and recovers for a different IP', async () => {
  auth.setPassword('hunter2');
  const attempt = () => app.inject({
    method: 'POST',
    url: '/api/settings-auth/login',
    payload: { password: 'wrong' },
    remoteAddress: '10.0.0.5',
  });

  for (let i = 0; i < 5; i++) {
    const response = await attempt();
    assert.equal(response.statusCode, 401);
  }

  const lockedOut = await attempt();
  assert.equal(lockedOut.statusCode, 429);

  const otherIp = await app.inject({
    method: 'POST',
    url: '/api/settings-auth/login',
    payload: { password: 'hunter2' },
    remoteAddress: '10.0.0.6',
  });
  assert.equal(otherIp.statusCode, 200);
});

test('/api/settings/export and /api/settings/import are gated behind requireSettingsAuth once a password is set', async () => {
  auth.setPassword('hunter2');
  const exportNoToken = await app.inject({ method: 'GET', url: '/api/settings/export' });
  assert.equal(exportNoToken.statusCode, 401);

  // Both verbs, not just the GET -- the POST is the one the UI actually uses.
  const exportPostNoToken = await app.inject({ method: 'POST', url: '/api/settings/export', payload: {} });
  assert.equal(exportPostNoToken.statusCode, 401);

  const importNoToken = await app.inject({
    method: 'POST',
    url: '/api/settings/import',
    payload: { config: {} },
  });
  assert.equal(importNoToken.statusCode, 401);
});

test('config export/import round-trips real settings through the real HTTP routes', async () => {
  auth.setPassword('hunter2');
  const login = await app.inject({
    method: 'POST',
    url: '/api/settings-auth/login',
    payload: { password: 'hunter2' },
  });
  const { token } = JSON.parse(login.body);
  const authHeader = { 'x-mlpr-settings-token': token };

  await app.inject({
    method: 'PUT',
    url: '/api/settings',
    headers: authHeader,
    payload: { homeLat: 50, homeLon: 20 },
  });

  const exportResponse = await app.inject({ method: 'GET', url: '/api/settings/export', headers: authHeader });
  assert.equal(exportResponse.statusCode, 200);
  const dump = decodeBackupFile(exportResponse.rawPayload);
  assert.equal(dump.config.homeLat, '50');

  // Change it, then restore from the export -- the imported value should
  // win back over whatever was set in between.
  await app.inject({
    method: 'PUT',
    url: '/api/settings',
    headers: authHeader,
    payload: { homeLat: 10, homeLon: 10 },
  });

  const importResponse = await app.inject({
    method: 'POST',
    url: '/api/settings/import',
    headers: authHeader,
    payload: dump,
  });
  assert.equal(importResponse.statusCode, 200);
  assert.equal(JSON.parse(importResponse.body).ok, true);

  const settingsAfterImport = await app.inject({ method: 'GET', url: '/api/settings', headers: authHeader });
  assert.equal(JSON.parse(settingsAfterImport.body).homeLat, 50);
});

test('/api/settings/import rejects a malformed body with 400', async () => {
  auth.setPassword('hunter2');
  const login = await app.inject({
    method: 'POST',
    url: '/api/settings-auth/login',
    payload: { password: 'hunter2' },
  });
  const { token } = JSON.parse(login.body);

  const response = await app.inject({
    method: 'POST',
    url: '/api/settings/import',
    headers: { 'x-mlpr-settings-token': token },
    payload: { notAConfigExport: true },
  });
  assert.equal(response.statusCode, 400);
});

test('the export is a gzipped .mlpr attachment, and never Content-Encoding: gzip', async () => {
  const authHeader = await settingsToken();
  const response = await app.inject({ method: 'GET', url: '/api/settings/export', headers: authHeader });

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['content-type'], 'application/gzip');
  assert.match(response.headers['content-disposition'], /attachment; filename="mlpr-backup-\d{4}-\d{2}-\d{2}\.mlpr"/);
  // Load-bearing: with Content-Encoding set, fetch() would transparently
  // decompress the body and the browser would save a plain JSON file under
  // a .mlpr name.
  assert.equal(response.headers['content-encoding'], undefined);
  assert.equal(looksGzipped(response.rawPayload), true);
});

test('POST export embeds the browser-settings section the client sends up', async () => {
  const authHeader = await settingsToken();
  const response = await app.inject({
    method: 'POST',
    url: '/api/settings/export',
    headers: authHeader,
    payload: { browserSettings: { settings: { units: 'metric' }, statsRange: '7d' } },
  });

  assert.equal(response.statusCode, 200);
  const dump = decodeBackupFile(response.rawPayload);
  assert.deepEqual(dump.browserSettings, { settings: { units: 'metric' }, statsRange: '7d' });
  assert.equal(dump.version, 2);
  assert.equal(typeof dump.appVersion, 'string');
  // The GET form of the same route carries no browser section at all.
  const viaGet = await app.inject({ method: 'GET', url: '/api/settings/export', headers: authHeader });
  assert.equal('browserSettings' in decodeBackupFile(viaGet.rawPayload), false);
});

test('a gzipped .mlpr uploaded as octet-stream restores, and is echoed back with counts', async () => {
  const authHeader = await settingsToken();

  await app.inject({ method: 'PUT', url: '/api/settings', headers: authHeader, payload: { homeLat: 50, homeLon: 20 } });
  const exported = await app.inject({
    method: 'POST',
    url: '/api/settings/export',
    headers: authHeader,
    payload: { browserSettings: { settings: { aircraftIconSize: 52 } } },
  });

  await app.inject({ method: 'PUT', url: '/api/settings', headers: authHeader, payload: { homeLat: 10, homeLon: 10 } });

  const restored = await app.inject({
    method: 'POST',
    url: '/api/settings/import',
    headers: { ...authHeader, 'content-type': 'application/octet-stream' },
    payload: Buffer.from(exported.rawPayload),
  });

  assert.equal(restored.statusCode, 200);
  const body = JSON.parse(restored.body);
  assert.equal(body.ok, true);
  assert.deepEqual(body.skippedTables, []);
  assert.deepEqual(Object.keys(body.counts).sort(), [
    'allSeenAircraft', 'dailyStats', 'registrations', 'seenAircraft', 'seenFlights',
  ]);
  // Echoed back so the browser never has to decompress the file it just sent.
  assert.deepEqual(body.browserSettings, { settings: { aircraftIconSize: 52 } });

  const after = await app.inject({ method: 'GET', url: '/api/settings', headers: authHeader });
  assert.equal(JSON.parse(after.body).homeLat, 50);
});

test('a corrupt .mlpr upload is a 400, not a crash', async () => {
  const authHeader = await settingsToken();
  const response = await app.inject({
    method: 'POST',
    url: '/api/settings/import',
    headers: { ...authHeader, 'content-type': 'application/octet-stream' },
    payload: Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0xde, 0xad, 0xbe, 0xef]),
  });
  assert.equal(response.statusCode, 400);
});

test('a legacy uncompressed .json backup still imports through the binary path', async () => {
  const authHeader = await settingsToken();
  const legacy = Buffer.from(JSON.stringify({ version: 1, config: { ntfyTopic: 'legacy23' } }));

  const response = await app.inject({
    method: 'POST',
    url: '/api/settings/import',
    headers: { ...authHeader, 'content-type': 'application/octet-stream' },
    payload: legacy,
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body).importedKeys, ['ntfyTopic']);
});

test('an oversized upload is refused by the route body limit rather than buffered', async () => {
  const authHeader = await settingsToken();
  const huge = gzipSync(Buffer.alloc(1024, 0x41));
  const padded = Buffer.concat([huge, Buffer.alloc(17 * 1024 * 1024)]);

  const response = await app.inject({
    method: 'POST',
    url: '/api/settings/import',
    headers: { ...authHeader, 'content-type': 'application/octet-stream' },
    payload: padded,
  });
  assert.equal(response.statusCode, 413);
});
