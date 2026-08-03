import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = mkdtempSync(join(tmpdir(), 'mlpr-seen-flights-test-'));
process.env.MLPR_DB_PATH = join(tmpDir, 'test.db');

const seenFlights = await import('./seen-flights.js');

after(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  seenFlights.resetSeenFlightsCache();
});

const T0 = new Date('2026-03-01T12:00:00Z').getTime();
const MIN = 60 * 1000;

test('a brand new flight is recorded with first/last seen set to now', () => {
  seenFlights.noteFlightSeen('RYR4521', T0);
  assert.equal(seenFlights.getSeenFlightsCount(), 1);
  assert.equal(seenFlights.getSeenFlightsCount(T0), 1);
});

test('a later sighting of the same flight advances last_seen_at but keeps it a single distinct flight', () => {
  seenFlights.noteFlightSeen('RYR4521', T0);
  seenFlights.noteFlightSeen('RYR4521', T0 + 10 * MIN);
  assert.equal(seenFlights.getSeenFlightsCount(), 1);
  // Still active as of a cutoff between the first and the last sighting.
  assert.equal(seenFlights.getSeenFlightsCount(T0 + 5 * MIN), 1);
});

test('getSeenFlightsCount(sinceMs) only counts flights last seen at/after the cutoff', () => {
  seenFlights.noteFlightSeen('RYR4521', T0); // stays quiet after this
  seenFlights.noteFlightSeen('WZZ123', T0 + 100 * MIN); // active recently

  assert.equal(seenFlights.getSeenFlightsCount(0), 2); // all-time
  assert.equal(seenFlights.getSeenFlightsCount(T0 + 50 * MIN), 1); // only WZZ123
});

test('flushDirtySeenFlights persists to SQLite and clears the dirty flag (a second flush finds nothing new)', () => {
  seenFlights.noteFlightSeen('RYR4521', T0);
  const flushed = seenFlights.flushDirtySeenFlights();
  assert.equal(flushed, 1);
  assert.equal(seenFlights.flushDirtySeenFlights(), 0);
});

test('state survives a fresh in-memory cache by reloading from SQLite (simulating a restart)', () => {
  seenFlights.noteFlightSeen('RYR4521', T0);
  seenFlights.flushDirtySeenFlights();
  seenFlights.resetSeenFlightsCache();

  assert.equal(seenFlights.getSeenFlightsCount(), 1);
  assert.equal(seenFlights.getSeenFlightsCount(T0), 1);
});
