import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = mkdtempSync(join(tmpdir(), 'mlpr-stats-registrations-test-'));
process.env.MLPR_DB_PATH = join(tmpDir, 'test.db');

const statsRegistrations = await import('./stats-registrations.js');
const db = await import('./db.js');

after(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  statsRegistrations.resetRegistrationsCache();
});

const T0 = new Date('2026-03-01T12:00:00Z').getTime();
const MIN = 60 * 1000;

test('a brand new registration is timesSeen=1 with first/last seen set to now', () => {
  statsRegistrations.recordSighting('SP-TEST', { typeCode: 'B738', airlineIcao: 'LOT' }, T0);
  const [entry] = statsRegistrations.getRegistrationsList();
  assert.equal(entry.registration, 'SP-TEST');
  assert.equal(entry.timesSeen, 1);
  assert.equal(entry.firstSeenAt, T0);
  assert.equal(entry.lastSeenAt, T0);
});

test('a re-sighting less than 15 minutes later does not increment timesSeen', () => {
  statsRegistrations.recordSighting('SP-TEST', { typeCode: 'B738' }, T0);
  statsRegistrations.recordSighting('SP-TEST', { typeCode: 'B738' }, T0 + 10 * MIN);
  const [entry] = statsRegistrations.getRegistrationsList();
  assert.equal(entry.timesSeen, 1);
  assert.equal(entry.lastSeenAt, T0 + 10 * MIN);
});

test('a re-sighting at/after 15 minutes later counts as a new visit', () => {
  statsRegistrations.recordSighting('SP-TEST', {}, T0);
  statsRegistrations.recordSighting('SP-TEST', {}, T0 + 15 * MIN);
  const [entry] = statsRegistrations.getRegistrationsList();
  assert.equal(entry.timesSeen, 2);
});

test('just under the 15-minute threshold does not count as a new visit', () => {
  statsRegistrations.recordSighting('SP-TEST', {}, T0);
  statsRegistrations.recordSighting('SP-TEST', {}, T0 + 15 * MIN - 1);
  const [entry] = statsRegistrations.getRegistrationsList();
  assert.equal(entry.timesSeen, 1);
});

test('typeCode/airlineIcao update when a later sighting provides them, but are not cleared when a later sighting lacks them', () => {
  statsRegistrations.recordSighting('SP-TEST', {}, T0);
  statsRegistrations.recordSighting('SP-TEST', { typeCode: 'B738', airlineIcao: 'LOT' }, T0 + MIN);
  statsRegistrations.recordSighting('SP-TEST', {}, T0 + 2 * MIN);
  const [entry] = statsRegistrations.getRegistrationsList();
  assert.equal(entry.typeCode, 'B738');
  assert.equal(entry.airlineIcao, 'LOT');
});

test('flushDirtyRegistrations persists to SQLite and clears the dirty flag (a second flush finds nothing new)', () => {
  statsRegistrations.recordSighting('SP-TEST', { typeCode: 'B738' }, T0);
  const firstFlushCount = statsRegistrations.flushDirtyRegistrations();
  assert.equal(firstFlushCount, 1);
  assert.notEqual(db.getRegistration('SP-TEST'), null);

  const secondFlushCount = statsRegistrations.flushDirtyRegistrations();
  assert.equal(secondFlushCount, 0);
});

test('state survives a fresh in-memory cache by reloading from SQLite (simulating a restart)', () => {
  statsRegistrations.recordSighting('SP-TEST', { typeCode: 'B738' }, T0);
  statsRegistrations.flushDirtyRegistrations();
  statsRegistrations.resetRegistrationsCache();

  // A restart should not treat this as a brand new registration.
  statsRegistrations.recordSighting('SP-TEST', {}, T0 + 20 * MIN);
  const [entry] = statsRegistrations.getRegistrationsList();
  assert.equal(entry.timesSeen, 2);
  assert.equal(entry.firstSeenAt, T0);
});

// Earlier tests in this file (deliberately) flush entries to the same
// shared SQLite temp file, and resetRegistrationsCache() forces a reload
// from it -- so aggregate tests below use a time anchor safely after every
// earlier test's timestamps, with a tight `sinceMs` cutoff, rather than
// depending on the DB being empty.
const T1 = T0 + 100000 * MIN;

test('getTypeCounts counts distinct registrations per type, only those active since the cutoff', () => {
  statsRegistrations.recordSighting('SP-ONE', { typeCode: 'B738' }, T1);
  statsRegistrations.recordSighting('SP-TWO', { typeCode: 'B738' }, T1);
  statsRegistrations.recordSighting('SP-THREE', { typeCode: 'A320' }, T1 - 1000 * MIN); // old, outside range

  const counts = statsRegistrations.getTypeCounts(T1 - MIN);
  assert.deepEqual(counts, [{ typeCode: 'B738', count: 2 }]);
});

test('getAirlineCounts counts distinct registrations per airline', () => {
  statsRegistrations.recordSighting('SP-ONE', { airlineIcao: 'LOT' }, T1);
  statsRegistrations.recordSighting('SP-TWO', { airlineIcao: 'LOT' }, T1);
  statsRegistrations.recordSighting('SP-THREE', { airlineIcao: 'RYR' }, T1);

  const counts = statsRegistrations.getAirlineCounts(T1 - MIN);
  assert.deepEqual(counts, [
    { airlineIcao: 'LOT', count: 2 },
    { airlineIcao: 'RYR', count: 1 },
  ]);
});

test('getNewRegistrationsBuckets buckets by first-seen date, ignoring registrations from before the cutoff', () => {
  statsRegistrations.recordSighting('SP-ONE', {}, T1);
  statsRegistrations.recordSighting('SP-TWO', {}, T1 + 60 * 60 * 1000);
  statsRegistrations.recordSighting('SP-OLD', {}, T1 - 100 * 24 * 60 * MIN);

  const buckets = statsRegistrations.getNewRegistrationsBuckets(T1 - MIN, 'day');
  assert.equal(buckets.length, 1);
  assert.equal(buckets[0].count, 2);
});

const T2 = T1 + 200000 * MIN;

test('getNewRegistrationsBucketsByKey splits new-registration counts per key, restricted to topKeys', () => {
  const T3 = T2 + 200000 * MIN;
  statsRegistrations.recordSighting('SP-X1', { typeCode: 'B738' }, T3);
  statsRegistrations.recordSighting('SP-X2', { typeCode: 'B738' }, T3);
  statsRegistrations.recordSighting('SP-X3', { typeCode: 'A320' }, T3);
  statsRegistrations.recordSighting('SP-X4', { typeCode: 'C172' }, T3); // not in topKeys -- excluded

  const buckets = statsRegistrations.getNewRegistrationsBucketsByKey(
    T3 - MIN,
    'day',
    (e) => e.typeCode,
    ['B738', 'A320'],
  );
  assert.equal(buckets.length, 1);
  assert.deepEqual(buckets[0].B738, 2);
  assert.deepEqual(buckets[0].A320, 1);
  assert.equal('C172' in buckets[0], false);
});

test('getNewRegistrationsBucketsByKey fills a zero for a topKey with no registrations in a bucket that does have others', () => {
  const T4 = T2 + 400000 * MIN;
  statsRegistrations.recordSighting('SP-Y1', { typeCode: 'B738' }, T4);

  const buckets = statsRegistrations.getNewRegistrationsBucketsByKey(
    T4 - MIN,
    'day',
    (e) => e.typeCode,
    ['B738', 'A320'],
  );
  assert.equal(buckets.length, 1);
  assert.equal(buckets[0].B738, 1);
  assert.equal(buckets[0].A320, 0);
});
