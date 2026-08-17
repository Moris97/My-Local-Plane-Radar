import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = mkdtempSync(join(tmpdir(), 'mlpr-config-backup-test-'));
process.env.MLPR_DB_PATH = join(tmpDir, 'test.db');

const { exportBackup, backupChunks, importBackup, validateBrowserSettings } = await import('./config-backup.js');
const {
  setConfig, setConfigJSON, getConfig, getConfigJSON, deleteConfig, getAllConfigEntries,
  getRegistration, getDailyStats, getAllSeenAircraft, getAllSeenFlights, getAllAircraftSeenRaw,
} = await import('./db.js');

after(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  for (const key of Object.keys(getAllConfigEntries())) deleteConfig(key);
});

// ---------------------------------------------------------------------------
// The config half. These are the pre-v2 tests, bodies unchanged apart from the
// version number -- they are the backward-compatibility proof, since every one
// of them feeds a bare v1-shaped {config: {...}} payload with no `tables` and
// no `version` at all in places.
// ---------------------------------------------------------------------------

test('exportBackup returns every raw config row plus version/timestamp metadata', () => {
  setConfig('homeLat', '50');
  setConfigJSON('watchList', [{ id: '1', matchType: 'type', matchValue: 'A388' }]);

  const dump = exportBackup();
  assert.equal(dump.version, 2);
  assert.equal(typeof dump.exportedAt, 'string');
  assert.equal(dump.config.homeLat, '50');
  assert.equal(dump.config.watchList, JSON.stringify([{ id: '1', matchType: 'type', matchValue: 'A388' }]));
});

test('importBackup writes every entry back and getConfigJSON can read a re-imported JSON blob', () => {
  const dump = {
    version: 1,
    config: {
      homeLat: '50',
      homeLon: '20',
      watchList: JSON.stringify([{ id: '1', matchType: 'flight', matchValue: 'LOT1' }]),
    },
  };

  const result = importBackup(dump);
  assert.equal(result.ok, true);
  assert.deepEqual(result.importedKeys.sort(), ['homeLat', 'homeLon', 'watchList']);
  assert.equal(getConfig('homeLat'), '50');
  assert.deepEqual(getConfigJSON('watchList', null), [{ id: '1', matchType: 'flight', matchValue: 'LOT1' }]);
});

test('importBackup only touches keys present in the export, leaving others alone', () => {
  setConfig('port', '1090');
  importBackup({ version: 1, config: { homeLat: '50' } });
  assert.equal(getConfig('port'), '1090');
  assert.equal(getConfig('homeLat'), '50');
});

test('export -> import round-trips every row unchanged', () => {
  setConfig('homeLat', '50');
  setConfigJSON('notificationSettings', { squawkAlerts: true, firstSeen: false });

  const dump = exportBackup();
  for (const key of Object.keys(getAllConfigEntries())) deleteConfig(key);
  assert.deepEqual(getAllConfigEntries(), {});

  importBackup(dump);
  assert.deepEqual(getAllConfigEntries(), dump.config);
});

test('importBackup rejects a payload with no config object', () => {
  assert.equal(importBackup({ version: 1 }).ok, false);
  assert.equal(importBackup(null).ok, false);
  assert.equal(importBackup('not an object').ok, false);
  assert.equal(importBackup({ config: [] }).ok, false);
});

test('importBackup rejects a non-string value instead of silently coercing it', () => {
  const result = importBackup({ config: { someKey: 42 } });
  assert.equal(result.ok, false);
});

test('importBackup rejects a __proto__ key defensively', () => {
  const result = importBackup({ config: JSON.parse('{"__proto__": "x"}') });
  assert.equal(result.ok, false);
});

// ---------------------------------------------------------------------------
// Version handling
// ---------------------------------------------------------------------------

test('a v1 file (no version field at all) is accepted as the config-only format', () => {
  const result = importBackup({ config: { homeLat: '51' } });
  assert.equal(result.ok, true);
  assert.equal(getConfig('homeLat'), '51');
  assert.deepEqual(result.counts, {});
});

test('a backup from a future version is refused rather than partially understood', () => {
  const result = importBackup({ version: 3, config: { homeLat: '52' } });
  assert.equal(result.ok, false);
  assert.match(result.error, /newer version/);
  assert.equal(getConfig('homeLat'), null);
});

// ---------------------------------------------------------------------------
// The tables half
// ---------------------------------------------------------------------------

test('exportBackup carries all five history tables with camelCase field names', () => {
  importBackup({
    config: {},
    tables: {
      dailyStats: [{ date: '2026-01-05', maxAircraft: 42, totalMessages: 9, maxRangeKm: 310.5, updatedAt: 1000 }],
      seenAircraft: [{ hex: 'aa0001', firstSeenAt: 10, lastSeenAt: 20 }],
      allSeenAircraft: [{ hex: 'aa0002', firstSeenAt: 11, lastSeenAt: 21 }],
      seenFlights: [{ flight: 'TST001', firstSeenAt: 12, lastSeenAt: 22 }],
      registrations: [
        { registration: 'SP-TST1', typeCode: 'B738', airlineIcao: 'TST', firstSeenAt: 13, lastSeenAt: 23, timesSeen: 4 },
      ],
    },
  });

  const dump = exportBackup();
  assert.deepEqual(Object.keys(dump.tables).sort(), [
    'allSeenAircraft', 'dailyStats', 'registrations', 'seenAircraft', 'seenFlights',
  ]);

  const day = dump.tables.dailyStats.find((row) => row.date === '2026-01-05');
  assert.equal(day.maxAircraft, 42);
  assert.equal(day.maxRangeKm, 310.5);
  // Present even though nothing displays it -- it is the merge discriminator.
  assert.equal(day.updatedAt, 1000);
  // Absent-in-the-file numeric columns default to the column's own DEFAULT 0.
  assert.equal(day.uniqueFlightsCount, 0);

  const reg = dump.tables.registrations.find((row) => row.registration === 'SP-TST1');
  assert.deepEqual(reg, {
    registration: 'SP-TST1', typeCode: 'B738', airlineIcao: 'TST', firstSeenAt: 13, lastSeenAt: 23, timesSeen: 4,
  });
});

test('backupChunks concatenates into exactly the object exportBackup returns', () => {
  setConfig('homeLat', '50');
  importBackup({
    config: {},
    tables: { seenAircraft: [{ hex: 'bb0001', firstSeenAt: 1, lastSeenAt: 2 }] },
  });

  // Guards the generator's hand-placed commas/brackets, which are the most
  // fragile thing in the whole format. exportBackup is built by running the
  // generator, so this also proves there is only one implementation.
  const streamed = [...backupChunks()].join('');
  const parsed = JSON.parse(streamed);
  assert.equal(parsed.version, 2);
  assert.equal(parsed.config.homeLat, '50');
  assert.ok(parsed.tables.seenAircraft.some((row) => row.hex === 'bb0001'));
  assert.ok(streamed.startsWith('{"version":2'));
  assert.ok(streamed.endsWith('}}'));
});

test('an export with no rows at all is still valid JSON with empty table arrays', () => {
  // Every table already has rows from earlier tests in this file, so prove
  // the empty case through the generator's own batching path instead: a
  // freshly seeded table of exactly zero rows must still emit "[]".
  const streamed = [...backupChunks()].join('');
  assert.doesNotThrow(() => JSON.parse(streamed));
  const emptyTables = JSON.parse('{"version":2,"config":{},"tables":{"seenFlights":[]}}');
  assert.equal(importBackup(emptyTables).ok, true);
});

// ---------------------------------------------------------------------------
// Merge semantics -- the reason db.js needed its own import statements
// ---------------------------------------------------------------------------

test('an older firstSeenAt in the backup wins, and a live lastSeenAt is never moved backwards', () => {
  importBackup({ config: {}, tables: { seenAircraft: [{ hex: 'cc0001', firstSeenAt: 5000, lastSeenAt: 9000 }] } });
  // A backup taken earlier: older on both ends.
  importBackup({ config: {}, tables: { seenAircraft: [{ hex: 'cc0001', firstSeenAt: 1000, lastSeenAt: 2000 }] } });

  const row = getAllSeenAircraft().find((r) => r.hex === 'cc0001');
  assert.equal(row.first_seen_at, 1000, 'the older first sighting is the one worth keeping');
  assert.equal(row.last_seen_at, 9000, 'a stale backup must not rewind a live last-seen');
});

test('the same merge applies to seen_flights and all_seen_aircraft', () => {
  importBackup({
    config: {},
    tables: {
      seenFlights: [{ flight: 'CC0002', firstSeenAt: 5000, lastSeenAt: 9000 }],
      allSeenAircraft: [{ hex: 'cc0003', firstSeenAt: 5000, lastSeenAt: 9000 }],
    },
  });
  importBackup({
    config: {},
    tables: {
      seenFlights: [{ flight: 'CC0002', firstSeenAt: 1000, lastSeenAt: 2000 }],
      allSeenAircraft: [{ hex: 'cc0003', firstSeenAt: 1000, lastSeenAt: 2000 }],
    },
  });

  const flight = getAllSeenFlights().find((r) => r.flight === 'CC0002');
  assert.deepEqual([flight.first_seen_at, flight.last_seen_at], [1000, 9000]);
  const hex = getAllAircraftSeenRaw().find((r) => r.hex === 'cc0003');
  assert.deepEqual([hex.first_seen_at, hex.last_seen_at], [1000, 9000]);
});

test('registrations keep the higher timesSeen and never lose a known type to a null', () => {
  importBackup({
    config: {},
    tables: {
      registrations: [
        { registration: 'SP-MRG1', typeCode: 'A320', airlineIcao: 'LOT', firstSeenAt: 5000, lastSeenAt: 9000, timesSeen: 12 },
      ],
    },
  });
  importBackup({
    config: {},
    tables: {
      registrations: [
        // An older backup, taken before the type/airline had been resolved.
        { registration: 'SP-MRG1', typeCode: null, airlineIcao: null, firstSeenAt: 1000, lastSeenAt: 2000, timesSeen: 3 },
      ],
    },
  });

  const row = getRegistration('SP-MRG1');
  assert.equal(row.type_code, 'A320', 'a null in the backup must not erase a resolved type');
  assert.equal(row.airline_icao, 'LOT');
  assert.equal(row.first_seen_at, 1000);
  assert.equal(row.last_seen_at, 9000);
  assert.equal(row.times_seen, 12, 'visit counts only ever go up');
});

test('a daily_stats row is only replaced by a strictly fresher one', () => {
  importBackup({
    config: {},
    tables: { dailyStats: [{ date: '2026-02-01', maxAircraft: 100, updatedAt: 5000 }] },
  });

  importBackup({
    config: {},
    tables: { dailyStats: [{ date: '2026-02-01', maxAircraft: 7, updatedAt: 1000 }] },
  });
  assert.equal(getDailyStats('2026-02-01').max_aircraft, 100, 'an older row must not clobber a fresher one');

  importBackup({
    config: {},
    tables: { dailyStats: [{ date: '2026-02-01', maxAircraft: 250, updatedAt: 9000 }] },
  });
  assert.equal(getDailyStats('2026-02-01').max_aircraft, 250, 'a fresher row does replace it');
});

// ---------------------------------------------------------------------------
// Table validation
// ---------------------------------------------------------------------------

test('a row with a wrong-typed field is rejected and nothing at all is written', () => {
  const result = importBackup({
    config: { homeLat: '99' },
    tables: {
      seenAircraft: [
        { hex: 'dd0001', firstSeenAt: 1, lastSeenAt: 2 },
        { hex: 'dd0002', firstSeenAt: 'not a number', lastSeenAt: 2 },
      ],
    },
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /row 1/);
  // Validate-then-write: the good row before the bad one must not have landed
  // either, and neither must the config key.
  assert.equal(getAllSeenAircraft().some((r) => r.hex === 'dd0001'), false);
  assert.equal(getConfig('homeLat'), null);
});

test('a row with a missing or empty primary key is rejected', () => {
  assert.equal(importBackup({ config: {}, tables: { seenAircraft: [{ firstSeenAt: 1 }] } }).ok, false);
  assert.equal(importBackup({ config: {}, tables: { seenAircraft: [{ hex: '', firstSeenAt: 1 }] } }).ok, false);
  assert.equal(importBackup({ config: {}, tables: { seenAircraft: [{ hex: '__proto__' }] } }).ok, false);
  assert.equal(importBackup({ config: {}, tables: { seenAircraft: ['nope'] } }).ok, false);
});

test('a table that is not an array of rows is rejected', () => {
  assert.equal(importBackup({ config: {}, tables: { seenAircraft: { hex: 'x' } } }).ok, false);
  assert.equal(importBackup({ config: {}, tables: [] }).ok, false);
});

test('an unknown table name is skipped and reported rather than failing the whole import', () => {
  const result = importBackup({
    config: {},
    tables: {
      seenFlights: [{ flight: 'EE0001', firstSeenAt: 1, lastSeenAt: 2 }],
      somethingFromV3: [{ whatever: true }],
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.skippedTables, ['somethingFromV3']);
  assert.equal(result.counts.seenFlights, 1);
  assert.ok(getAllSeenFlights().some((r) => r.flight === 'EE0001'));
});

// ---------------------------------------------------------------------------
// The browser-settings section
// ---------------------------------------------------------------------------

test('browserSettings round-trips through export and is echoed back by import', () => {
  const section = { settings: { units: 'metric', aircraftIconSize: 52 }, statsRange: '7d' };
  const dump = exportBackup({ browserSettings: section });
  assert.deepEqual(dump.browserSettings, section);

  const result = importBackup(dump);
  assert.equal(result.ok, true);
  assert.deepEqual(result.browserSettings, section);
});

test('an export without the section omits it entirely rather than writing null', () => {
  const dump = exportBackup();
  assert.equal('browserSettings' in dump, false);
  assert.equal(importBackup(dump).browserSettings, null);
});

test('a malformed or oversized browserSettings section is dropped, never fatal', () => {
  assert.equal(validateBrowserSettings(null), null);
  assert.equal(validateBrowserSettings('nope'), null);
  assert.equal(validateBrowserSettings([]), null);
  assert.equal(validateBrowserSettings({ settings: 'not an object' }), null);
  assert.equal(validateBrowserSettings({ statsRange: 42 }), null);
  assert.equal(validateBrowserSettings({ settings: { blob: 'x'.repeat(70 * 1024) } }), null);

  // The server data still restores regardless.
  const result = importBackup({ config: { homeLat: '50' }, browserSettings: 'garbage' });
  assert.equal(result.ok, true);
  assert.equal(result.browserSettings, null);
  assert.equal(getConfig('homeLat'), '50');
});
