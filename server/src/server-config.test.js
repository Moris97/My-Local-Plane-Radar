import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { validatePort, resolvePort, setConfiguredPort, getConfiguredPort, DEFAULT_PORT } from './server-config.js';
import { deleteConfig } from './db.js';

beforeEach(() => {
  deleteConfig('port');
});

test('validatePort accepts an ordinary unprivileged port', () => {
  assert.deepEqual(validatePort(1090), { ok: true, port: 1090 });
  assert.deepEqual(validatePort(8000), { ok: true, port: 8000 });
});

test('validatePort rejects privileged and out-of-range ports', () => {
  // Below 1024 would need root, which MLPR deliberately never runs as.
  assert.equal(validatePort(80).ok, false);
  assert.equal(validatePort(1023).ok, false);
  assert.equal(validatePort(65536).ok, false);
  assert.equal(validatePort(0).ok, false);
});

test('validatePort rejects non-integers', () => {
  assert.equal(validatePort(1090.5).ok, false);
  assert.equal(validatePort('1090').ok, false);
  assert.equal(validatePort(NaN).ok, false);
  assert.equal(validatePort(undefined).ok, false);
});

test("validatePort rejects readsb's ports, so the UI can never break the receiver MLPR reads from", () => {
  for (const port of [30001, 30002, 30003, 30004, 30005, 30104]) {
    const result = validatePort(port);
    assert.equal(result.ok, false, `expected ${port} to be rejected`);
    assert.match(result.error, /readsb/);
  }
});

test('validatePort rejects ports known to be used by other apps on the target host', () => {
  assert.equal(validatePort(8080).ok, false);
  assert.equal(validatePort(8085).ok, false);
});

test('resolvePort falls back to the default when nothing is configured', () => {
  assert.deepEqual(resolvePort({}), { port: DEFAULT_PORT, source: 'default' });
});

test('resolvePort uses the stored config value when there is no env override', () => {
  setConfiguredPort(9000);
  assert.deepEqual(resolvePort({}), { port: 9000, source: 'config' });
});

test('MLPR_PORT overrides the stored config value, and says so', () => {
  // Otherwise an explicit deployment/dev override would appear to be
  // silently ignored in favour of whatever is in the database.
  setConfiguredPort(9000);
  assert.deepEqual(resolvePort({ MLPR_PORT: '1234' }), { port: 1234, source: 'env' });
});

test('getConfiguredPort round-trips through the database and is null when unset', () => {
  assert.equal(getConfiguredPort(), null);
  setConfiguredPort(4321);
  assert.equal(getConfiguredPort(), 4321);
});
