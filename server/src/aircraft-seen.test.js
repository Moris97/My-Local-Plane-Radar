import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = mkdtempSync(join(tmpdir(), 'mlpr-aircraft-seen-test-'));
process.env.MLPR_DB_PATH = join(tmpDir, 'test.db');

const aircraftSeen = await import('./aircraft-seen.js');

after(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  aircraftSeen.resetAircraftSeenCache();
});

const T0 = new Date('2026-03-01T12:00:00Z').getTime();
const MIN = 60 * 1000;

test('a brand new hex is recorded with no confirmation gate -- one sighting is enough', () => {
  aircraftSeen.noteAircraftSeen('abc123', T0);
  assert.equal(aircraftSeen.getAircraftSeenCount(), 1);
});

test('getAircraftSeenCount(sinceMs) only counts hexes last seen at/after the cutoff', () => {
  aircraftSeen.noteAircraftSeen('old', T0);
  aircraftSeen.noteAircraftSeen('recent', T0 + 100 * MIN);

  assert.equal(aircraftSeen.getAircraftSeenCount(0), 2);
  assert.equal(aircraftSeen.getAircraftSeenCount(T0 + 50 * MIN), 1);
});

test('flushDirtyAircraftSeen persists to SQLite and clears the dirty flag', () => {
  aircraftSeen.noteAircraftSeen('abc123', T0);
  assert.equal(aircraftSeen.flushDirtyAircraftSeen(), 1);
  assert.equal(aircraftSeen.flushDirtyAircraftSeen(), 0);
});

test('state survives a fresh in-memory cache by reloading from SQLite (simulating a restart)', () => {
  aircraftSeen.noteAircraftSeen('abc123', T0);
  aircraftSeen.flushDirtyAircraftSeen();
  aircraftSeen.resetAircraftSeenCache();

  assert.equal(aircraftSeen.getAircraftSeenCount(), 1);
});
