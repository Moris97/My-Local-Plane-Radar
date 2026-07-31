import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = mkdtempSync(join(tmpdir(), 'mlpr-config-backup-test-'));
process.env.MLPR_DB_PATH = join(tmpDir, 'test.db');

const { exportConfig, importConfig } = await import('./config-backup.js');
const { setConfig, setConfigJSON, getConfig, getConfigJSON, deleteConfig, getAllConfigEntries } = await import('./db.js');

after(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  for (const key of Object.keys(getAllConfigEntries())) deleteConfig(key);
});

test('exportConfig returns every raw config row plus version/timestamp metadata', () => {
  setConfig('homeLat', '50');
  setConfigJSON('watchList', [{ id: '1', matchType: 'type', matchValue: 'A388' }]);

  const dump = exportConfig();
  assert.equal(dump.version, 1);
  assert.equal(typeof dump.exportedAt, 'string');
  assert.equal(dump.config.homeLat, '50');
  assert.equal(dump.config.watchList, JSON.stringify([{ id: '1', matchType: 'type', matchValue: 'A388' }]));
});

test('importConfig writes every entry back and getConfigJSON can read a re-imported JSON blob', () => {
  const dump = {
    version: 1,
    config: {
      homeLat: '50',
      homeLon: '20',
      watchList: JSON.stringify([{ id: '1', matchType: 'flight', matchValue: 'LOT1' }]),
    },
  };

  const result = importConfig(dump);
  assert.equal(result.ok, true);
  assert.deepEqual(result.importedKeys.sort(), ['homeLat', 'homeLon', 'watchList']);
  assert.equal(getConfig('homeLat'), '50');
  assert.deepEqual(getConfigJSON('watchList', null), [{ id: '1', matchType: 'flight', matchValue: 'LOT1' }]);
});

test('importConfig only touches keys present in the export, leaving others alone', () => {
  setConfig('port', '1090');
  importConfig({ version: 1, config: { homeLat: '50' } });
  assert.equal(getConfig('port'), '1090');
  assert.equal(getConfig('homeLat'), '50');
});

test('export -> import round-trips every row unchanged', () => {
  setConfig('homeLat', '50');
  setConfigJSON('notificationSettings', { squawkAlerts: true, firstSeen: false });

  const dump = exportConfig();
  for (const key of Object.keys(getAllConfigEntries())) deleteConfig(key);
  assert.deepEqual(getAllConfigEntries(), {});

  importConfig(dump);
  assert.deepEqual(getAllConfigEntries(), dump.config);
});

test('importConfig rejects a payload with no config object', () => {
  assert.equal(importConfig({ version: 1 }).ok, false);
  assert.equal(importConfig(null).ok, false);
  assert.equal(importConfig('not an object').ok, false);
  assert.equal(importConfig({ config: [] }).ok, false);
});

test('importConfig rejects a non-string value instead of silently coercing it', () => {
  const result = importConfig({ config: { someKey: 42 } });
  assert.equal(result.ok, false);
});

test('importConfig rejects a __proto__ key defensively', () => {
  const result = importConfig({ config: JSON.parse('{"__proto__": "x"}') });
  assert.equal(result.ok, false);
});
