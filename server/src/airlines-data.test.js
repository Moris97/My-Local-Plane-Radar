import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = mkdtempSync(join(tmpdir(), 'mlpr-airlines-test-'));
const dataPath = join(tmpDir, 'airlines.json');
process.env.MLPR_AIRLINES_PATH = dataPath;

const { getAirlines } = await import('./airlines-data.js');

after(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

test('getAirlines returns an empty map when the data file has never been fetched', () => {
  assert.equal(getAirlines().size, 0);
});

test('getAirlines picks up the file once it appears, without needing a restart', () => {
  writeFileSync(dataPath, JSON.stringify({ RYR: { name: 'Ryanair', country: 'Ireland' } }));
  assert.deepEqual(getAirlines().get('RYR'), { name: 'Ryanair', country: 'Ireland' });
});

test('getAirlines picks up a later change to the file (re-fetch overwriting stale data)', () => {
  writeFileSync(dataPath, JSON.stringify({ RYR: { name: 'Ryanair', country: 'Ireland' } }));
  getAirlines();
  // Force the mtime forward -- a same-millisecond rewrite could otherwise
  // look unchanged on a fast filesystem.
  const future = new Date(Date.now() + 5000);
  writeFileSync(dataPath, JSON.stringify({ LOT: { name: 'LOT Polish Airlines', country: 'Poland' } }));
  utimesSync(dataPath, future, future);
  const airlines = getAirlines();
  assert.equal(airlines.has('RYR'), false);
  assert.deepEqual(airlines.get('LOT'), { name: 'LOT Polish Airlines', country: 'Poland' });
});

test('getAirlines keeps the last good map if the file becomes unreadable/corrupt', () => {
  writeFileSync(dataPath, JSON.stringify({ WZZ: { name: 'Wizz Air', country: 'Hungary' } }));
  const future = new Date(Date.now() + 10000);
  utimesSync(dataPath, future, future);
  getAirlines();
  const future2 = new Date(Date.now() + 15000);
  writeFileSync(dataPath, '{ not valid json');
  utimesSync(dataPath, future2, future2);
  assert.deepEqual(getAirlines().get('WZZ'), { name: 'Wizz Air', country: 'Hungary' });
});
