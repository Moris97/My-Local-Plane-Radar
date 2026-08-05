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

test('seen_aircraft: getAllSeenAircraft/upsertSeenAircraft round-trip, including advancing last_seen_at on conflict', () => {
  db.upsertSeenAircraft([{ hex: 'deadbf', firstSeenAt: 100, lastSeenAt: 100 }]);
  let row = db.getAllSeenAircraft().find((r) => r.hex === 'deadbf');
  assert.equal(row.first_seen_at, 100);
  assert.equal(row.last_seen_at, 100);

  db.upsertSeenAircraft([{ hex: 'deadbf', firstSeenAt: 100, lastSeenAt: 900 }]);
  const rows = db.getAllSeenAircraft().filter((r) => r.hex === 'deadbf');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].last_seen_at, 900);
});

test('all_seen_aircraft: getAllAircraftSeenRaw/upsertAircraftSeenRaw round-trip, a separate table from seen_aircraft', () => {
  db.upsertAircraftSeenRaw([{ hex: 'cafe01', firstSeenAt: 200, lastSeenAt: 200 }]);
  const row = db.getAllAircraftSeenRaw().find((r) => r.hex === 'cafe01');
  assert.equal(row.first_seen_at, 200);
  // Writing to all_seen_aircraft must not create a row in seen_aircraft --
  // the two tables track deliberately different, independent definitions.
  assert.equal(db.getAllSeenAircraft().find((r) => r.hex === 'cafe01'), undefined);
});

test('seen_flights: getAllSeenFlights/upsertSeenFlights round-trip, including advancing last_seen_at on conflict', () => {
  db.upsertSeenFlights([{ flight: 'RYR4521', firstSeenAt: 100, lastSeenAt: 100 }]);
  let row = db.getAllSeenFlights().find((r) => r.flight === 'RYR4521');
  assert.equal(row.first_seen_at, 100);
  assert.equal(row.last_seen_at, 100);

  // Re-upserting the same flight must advance last_seen_at without
  // duplicating the row or resetting first_seen_at.
  db.upsertSeenFlights([{ flight: 'RYR4521', firstSeenAt: 100, lastSeenAt: 900 }]);
  const rows = db.getAllSeenFlights().filter((r) => r.flight === 'RYR4521');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].first_seen_at, 100);
  assert.equal(rows[0].last_seen_at, 900);
});

test('seen_flights: upsertSeenFlights with an empty array is a no-op', () => {
  assert.doesNotThrow(() => db.upsertSeenFlights([]));
});

test('WAL journal mode is actually active on this database', () => {
  // The whole point of setting it is SD-wear on the Pi -- worth a
  // regression test in case a future change (or a node:sqlite upgrade
  // resetting connection state) silently drops back to the default
  // rollback-journal mode.
  assert.equal(String(db.getJournalModeForTests()).toLowerCase(), 'wal');
});

test('runBatch commits every write when used standalone', () => {
  db.runBatch(() => {
    db.setConfig('batchKey1', 'a');
    db.setConfig('batchKey2', 'b');
  });
  assert.equal(db.getConfig('batchKey1'), 'a');
  assert.equal(db.getConfig('batchKey2'), 'b');
});

test('runBatch rolls back every write in the batch if one throws', () => {
  db.setConfig('rollbackKey', 'before');
  assert.throws(() => {
    db.runBatch(() => {
      db.setConfig('rollbackKey', 'after');
      throw new Error('boom');
    });
  }, /boom/);
  assert.equal(db.getConfig('rollbackKey'), 'before');
});

test('runBatch nests via SAVEPOINT: a nested call\'s writes still land when the outer call commits', () => {
  // Mirrors index.js's flushDailyStats calling upsertRegistrations (which
  // calls runBatch on its own) from inside its own outer runBatch --
  // node:sqlite throws on a literal nested BEGIN, so this is the regression
  // test for that reentrancy.
  db.runBatch(() => {
    db.setConfig('outerKey', 'outer');
    db.runBatch(() => {
      db.setConfig('innerKey', 'inner');
    });
  });
  assert.equal(db.getConfig('outerKey'), 'outer');
  assert.equal(db.getConfig('innerKey'), 'inner');
});

test('runBatch nests via SAVEPOINT: an inner failure rolls back only the inner writes, not the outer ones', () => {
  db.setConfig('nestedRollback', 'before');
  assert.throws(() => {
    db.runBatch(() => {
      db.setConfig('outerSurvives', 'yes');
      try {
        db.runBatch(() => {
          db.setConfig('nestedRollback', 'after');
          throw new Error('inner boom');
        });
      } catch {
        // Swallowed here deliberately, to isolate that the inner SAVEPOINT
        // itself rolled back correctly regardless of what the outer caller
        // does with the error -- a separate throw below is what actually
        // exercises the outer rollback path.
      }
      throw new Error('outer boom too');
    });
  }, /outer boom too/);
  // The whole outer transaction rolled back (it threw), so even the write
  // that survived the *inner* rollback must not have persisted either.
  assert.equal(db.getConfig('outerSurvives'), null);
  assert.equal(db.getConfig('nestedRollback'), 'before');
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
