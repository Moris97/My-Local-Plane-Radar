import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = mkdtempSync(join(tmpdir(), 'mlpr-db-test-'));
process.env.MLPR_DB_PATH = join(tmpDir, 'test.db');

const db = await import('./db.js');

after(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

test('getConfig returns null for a key that was never set', () => {
  assert.equal(db.getConfig('nope'), null);
});

test('setConfig/getConfig round-trip', () => {
  db.setConfig('homeLat', '50.0');
  assert.equal(db.getConfig('homeLat'), '50.0');
});

test('setConfig overwrites an existing key', () => {
  db.setConfig('homeLat', '50.0');
  db.setConfig('homeLat', '51.5');
  assert.equal(db.getConfig('homeLat'), '51.5');
});

test('deleteConfig removes the key', () => {
  db.setConfig('temp', 'x');
  db.deleteConfig('temp');
  assert.equal(db.getConfig('temp'), null);
});

test('upsertDailyStats creates a new row', () => {
  db.upsertDailyStats('2026-01-01', { maxAircraft: 5, totalMessages: 1000, maxRangeKm: 123.4 });
  const row = db.getDailyStats('2026-01-01');
  assert.equal(row.max_aircraft, 5);
  assert.equal(row.total_messages, 1000);
  assert.equal(row.max_range_km, 123.4);
});

test('upsertDailyStats overwrites (not accumulates) on conflict', () => {
  db.upsertDailyStats('2026-01-02', { maxAircraft: 5, totalMessages: 1000, maxRangeKm: 100 });
  db.upsertDailyStats('2026-01-02', { maxAircraft: 8, totalMessages: 2000, maxRangeKm: 150 });
  const row = db.getDailyStats('2026-01-02');
  assert.equal(row.max_aircraft, 8);
  assert.equal(row.total_messages, 2000);
  assert.equal(row.max_range_km, 150);
});

test('getDailyStats returns null for a date with no data', () => {
  assert.equal(db.getDailyStats('1999-01-01'), null);
});
