import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = mkdtempSync(join(tmpdir(), 'mlpr-server-test-'));
process.env.MLPR_DB_PATH = join(tmpDir, 'test.db');

const { buildServer } = await import('./server.js');
const auth = await import('./settings-auth.js');

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
  const dump = JSON.parse(exportResponse.body);
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
