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

test('upsertDailyStats stores the new avg/with-pos/without-pos/percentile columns', () => {
  db.upsertDailyStats('2026-02-01', {
    maxAircraft: 10,
    totalMessages: 500,
    maxRangeKm: 200,
    avgAircraft: 4.5,
    avgWithPos: 3.5,
    maxWithPos: 8,
    avgWithoutPos: 1,
    maxWithoutPos: 2,
    rangeTopAvgKm: 180,
  });
  const row = db.getDailyStats('2026-02-01');
  assert.equal(row.avg_aircraft, 4.5);
  assert.equal(row.avg_with_pos, 3.5);
  assert.equal(row.max_with_pos, 8);
  assert.equal(row.avg_without_pos, 1);
  assert.equal(row.max_without_pos, 2);
  assert.equal(row.range_top_avg_km, 180);
});

test('upsertDailyStats defaults the new columns to 0 when omitted', () => {
  db.upsertDailyStats('2026-02-02', { maxAircraft: 1, totalMessages: 1, maxRangeKm: 1 });
  const row = db.getDailyStats('2026-02-02');
  assert.equal(row.avg_aircraft, 0);
  assert.equal(row.range_top_avg_km, 0);
});

test('getAllDailyStats returns rows ordered by date ascending', () => {
  db.upsertDailyStats('2026-03-05', { maxAircraft: 1, totalMessages: 1, maxRangeKm: 1 });
  db.upsertDailyStats('2026-03-03', { maxAircraft: 1, totalMessages: 1, maxRangeKm: 1 });
  db.upsertDailyStats('2026-03-04', { maxAircraft: 1, totalMessages: 1, maxRangeKm: 1 });
  const rows = db.getAllDailyStats();
  const dates = rows.map((r) => r.date);
  const sorted = [...dates].sort();
  assert.deepEqual(dates, sorted);
});

test('getDailyStatsSince only returns rows on or after the given date', () => {
  db.upsertDailyStats('2026-04-01', { maxAircraft: 1, totalMessages: 1, maxRangeKm: 1 });
  db.upsertDailyStats('2026-04-10', { maxAircraft: 1, totalMessages: 1, maxRangeKm: 1 });
  const rows = db.getDailyStatsSince('2026-04-05');
  assert.equal(rows.some((r) => r.date === '2026-04-01'), false);
  assert.equal(rows.some((r) => r.date === '2026-04-10'), true);
});

test('registrations: upsertRegistration creates a new row, getRegistration reads it back', () => {
  assert.equal(db.getRegistration('SP-TEST'), null);
  db.upsertRegistration('SP-TEST', {
    typeCode: 'B738',
    airlineIcao: 'LOT',
    firstSeenAt: 1000,
    lastSeenAt: 1000,
    timesSeen: 1,
  });
  const row = db.getRegistration('SP-TEST');
  assert.equal(row.type_code, 'B738');
  assert.equal(row.airline_icao, 'LOT');
  assert.equal(row.first_seen_at, 1000);
  assert.equal(row.times_seen, 1);
});

test('registrations: upsertRegistration on conflict updates last_seen_at/times_seen but keeps first_seen_at', () => {
  db.upsertRegistration('SP-ABC', {
    typeCode: 'A320',
    airlineIcao: 'WZZ',
    firstSeenAt: 1000,
    lastSeenAt: 1000,
    timesSeen: 1,
  });
  db.upsertRegistration('SP-ABC', {
    typeCode: 'A320',
    airlineIcao: 'WZZ',
    firstSeenAt: 1000,
    lastSeenAt: 5000,
    timesSeen: 2,
  });
  const row = db.getRegistration('SP-ABC');
  assert.equal(row.first_seen_at, 1000);
  assert.equal(row.last_seen_at, 5000);
  assert.equal(row.times_seen, 2);
});

test('registrations: upsertRegistrations batches multiple entries in one call', () => {
  db.upsertRegistrations([
    { registration: 'SP-ONE', typeCode: 'B738', airlineIcao: 'LOT', firstSeenAt: 1, lastSeenAt: 1, timesSeen: 1 },
    { registration: 'SP-TWO', typeCode: 'A320', airlineIcao: 'WZZ', firstSeenAt: 2, lastSeenAt: 2, timesSeen: 1 },
  ]);
  assert.notEqual(db.getRegistration('SP-ONE'), null);
  assert.notEqual(db.getRegistration('SP-TWO'), null);
});

test('registrations: upsertRegistrations with an empty array is a no-op', () => {
  assert.doesNotThrow(() => db.upsertRegistrations([]));
});

test('getRegistrationsSince only returns registrations last seen on or after the cutoff', () => {
  db.upsertRegistration('SP-OLD', { typeCode: null, airlineIcao: null, firstSeenAt: 100, lastSeenAt: 100, timesSeen: 1 });
  db.upsertRegistration('SP-NEW', { typeCode: null, airlineIcao: null, firstSeenAt: 900, lastSeenAt: 900, timesSeen: 1 });
  const rows = db.getRegistrationsSince(500);
  assert.equal(rows.some((r) => r.registration === 'SP-OLD'), false);
  assert.equal(rows.some((r) => r.registration === 'SP-NEW'), true);
});

test('upsertDailyStats stores unique aircraft/flights counts, defaulting to 0', () => {
  db.upsertDailyStats('2026-05-01', {
    maxAircraft: 1,
    totalMessages: 1,
    maxRangeKm: 1,
    uniqueAircraftCount: 12,
    uniqueFlightsCount: 9,
  });
  const row = db.getDailyStats('2026-05-01');
  assert.equal(row.unique_aircraft_count, 12);
  assert.equal(row.unique_flights_count, 9);

  db.upsertDailyStats('2026-05-02', { maxAircraft: 1, totalMessages: 1, maxRangeKm: 1 });
  const defaulted = db.getDailyStats('2026-05-02');
  assert.equal(defaulted.unique_aircraft_count, 0);
  assert.equal(defaulted.unique_flights_count, 0);
});

test('seen_aircraft: hasSeenAircraft/markAircraftSeen/getSeenAircraftCount', () => {
  const before = db.getSeenAircraftCount();
  assert.equal(db.hasSeenAircraft('deadbe'), false);
  db.markAircraftSeen('deadbe');
  assert.equal(db.hasSeenAircraft('deadbe'), true);
  assert.equal(db.getSeenAircraftCount(), before + 1);
  // Marking the same hex again must not double-count.
  db.markAircraftSeen('deadbe');
  assert.equal(db.getSeenAircraftCount(), before + 1);
});

test('seen_flights: hasSeenFlight/markFlightSeen/getSeenFlightsCount', () => {
  const before = db.getSeenFlightsCount();
  assert.equal(db.hasSeenFlight('RYR4521'), false);
  db.markFlightSeen('RYR4521');
  assert.equal(db.hasSeenFlight('RYR4521'), true);
  assert.equal(db.getSeenFlightsCount(), before + 1);
  db.markFlightSeen('RYR4521');
  assert.equal(db.getSeenFlightsCount(), before + 1);
});

test('getRegistrationsCount reflects the number of distinct registrations stored', () => {
  const before = db.getRegistrationsCount();
  db.upsertRegistration('SP-COUNTME', { typeCode: 'B738', airlineIcao: 'LOT', firstSeenAt: 1, lastSeenAt: 1, timesSeen: 1 });
  assert.equal(db.getRegistrationsCount(), before + 1);
  // Re-upserting the same registration must not double-count.
  db.upsertRegistration('SP-COUNTME', { typeCode: 'B738', airlineIcao: 'LOT', firstSeenAt: 1, lastSeenAt: 2, timesSeen: 2 });
  assert.equal(db.getRegistrationsCount(), before + 1);
});

test('getAllAirlinesSummary groups registrations by airline, excluding unmatched ones', () => {
  db.upsertRegistration('SP-AIR1', { typeCode: 'B738', airlineIcao: 'TESTAIR', firstSeenAt: 100, lastSeenAt: 500, timesSeen: 3 });
  db.upsertRegistration('SP-AIR2', { typeCode: 'A320', airlineIcao: 'TESTAIR', firstSeenAt: 200, lastSeenAt: 900, timesSeen: 2 });
  db.upsertRegistration('SP-NOAIR', { typeCode: 'C172', airlineIcao: null, firstSeenAt: 300, lastSeenAt: 300, timesSeen: 1 });

  const summary = db.getAllAirlinesSummary();
  const entry = summary.find((s) => s.airlineIcao === 'TESTAIR');
  assert.ok(entry, 'expected a TESTAIR entry');
  assert.equal(entry.registrationsCount, 2);
  assert.equal(entry.totalTimesSeen, 5);
  assert.equal(entry.firstSeenAt, 100);
  assert.equal(entry.lastSeenAt, 900);
  assert.equal(summary.some((s) => s.airlineIcao === null), false);
});
