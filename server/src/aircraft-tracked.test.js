import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = mkdtempSync(join(tmpdir(), 'mlpr-aircraft-tracked-test-'));
process.env.MLPR_DB_PATH = join(tmpDir, 'test.db');

const aircraftTracked = await import('./aircraft-tracked.js');

after(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  aircraftTracked.resetAircraftTrackedCache();
});

const T0 = new Date('2026-03-01T12:00:00Z').getTime();
const MIN = 60 * 1000;

test('a hex is not tracked until markAircraftSeen confirms it -- touchAircraftTracked alone never creates one', () => {
  aircraftTracked.touchAircraftTracked('abc123', T0);
  assert.equal(aircraftTracked.hasSeenAircraft('abc123'), false);
  assert.equal(aircraftTracked.getAircraftTrackedCount(), 0);
});

test('markAircraftSeen confirms a hex; touchAircraftTracked then advances last_seen_at for it', () => {
  aircraftTracked.markAircraftSeen('abc123', T0);
  assert.equal(aircraftTracked.hasSeenAircraft('abc123'), true);
  assert.equal(aircraftTracked.getAircraftTrackedCount(T0), 1);

  // Without a later touch, the confirmed hex would age out of a tight
  // recent-cutoff view even though it's still the same, single aircraft.
  assert.equal(aircraftTracked.getAircraftTrackedCount(T0 + 100 * MIN), 0);
  aircraftTracked.touchAircraftTracked('abc123', T0 + 100 * MIN);
  assert.equal(aircraftTracked.getAircraftTrackedCount(T0 + 100 * MIN), 1);
});

test('flushDirtyAircraftTracked persists to SQLite and clears the dirty flag', () => {
  aircraftTracked.markAircraftSeen('abc123', T0);
  assert.equal(aircraftTracked.flushDirtyAircraftTracked(), 1);
  assert.equal(aircraftTracked.flushDirtyAircraftTracked(), 0);
});

test('state survives a fresh in-memory cache by reloading from SQLite (simulating a restart)', () => {
  aircraftTracked.markAircraftSeen('abc123', T0);
  aircraftTracked.flushDirtyAircraftTracked();
  aircraftTracked.resetAircraftTrackedCache();

  assert.equal(aircraftTracked.hasSeenAircraft('abc123'), true);
  assert.equal(aircraftTracked.getAircraftTrackedCount(), 1);
});
