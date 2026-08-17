import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultDataDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data');
const dbPath = process.env.MLPR_DB_PATH ?? join(defaultDataDir, 'mlpr.db');
mkdirSync(dirname(dbPath), { recursive: true });

const db = new DatabaseSync(dbPath);

// WAL means a reader (any GET /api/* handler) never blocks a writer and
// vice versa, and -- the actual SD-wear motivation -- each committed
// transaction is an append to the WAL file rather than a rollback-journal
// file being created, fsynced and deleted every single time. NORMAL
// synchronous is the documented pairing for WAL (still fsyncs at every
// checkpoint, just not after every single transaction) -- this app already
// accepts losing a restart's worth of in-memory state as normal (hard rule
// 6), so trading a little durability on the rare unclean-shutdown/power-cut
// case for meaningfully less flash wear on every routine write fits the
// same tradeoff already made everywhere else in this file.
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA synchronous = NORMAL');

// Test-only: confirms the PRAGMA above actually took effect (SQLite ignores
// journal_mode=WAL and silently stays on its default for some setups, e.g.
// certain in-memory or exotic filesystem cases), rather than trusting that
// setting it was the same as it being active.
export function getJournalModeForTests() {
  return db.prepare('PRAGMA journal_mode').get().journal_mode;
}

db.exec(`
  CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS daily_stats (
    date TEXT PRIMARY KEY,
    max_aircraft INTEGER NOT NULL DEFAULT 0,
    total_messages INTEGER NOT NULL DEFAULT 0,
    max_range_km REAL NOT NULL DEFAULT 0,
    avg_aircraft REAL NOT NULL DEFAULT 0,
    avg_with_pos REAL NOT NULL DEFAULT 0,
    max_with_pos INTEGER NOT NULL DEFAULT 0,
    avg_without_pos REAL NOT NULL DEFAULT 0,
    max_without_pos INTEGER NOT NULL DEFAULT 0,
    range_top_avg_km REAL NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  )
`);

// The *confirmed* aircraft tracker -- a hex only lands here once the
// first-seen notification's own 3s "second look" delay has passed (see
// notifications/rules.js's pendingFirstSeen), filtering out one-off Mode-S
// blips. Exposed to Stats as "Aircraft tracked". last_seen_at lets that
// tile answer "confirmed and still active in this range", the same way
// seen_flights already does for callsigns.
db.exec(`
  CREATE TABLE IF NOT EXISTS seen_aircraft (
    hex TEXT PRIMARY KEY,
    first_seen_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL DEFAULT 0
  )
`);

// The *raw* aircraft tracker -- unlike seen_aircraft above, every hex the
// receiver ever gets a single message from lands here immediately, no
// confirmation delay. Exposed to Stats as "Aircraft seen" -- deliberately a
// separate table from seen_aircraft rather than the same one with a looser
// query, so the two tiles' very different definitions ("every glimpse" vs
// "confirmed contact") can never accidentally blur into each other. Always
// a superset of seen_aircraft: every confirmed hex was necessarily raw-seen
// at least once first.
db.exec(`
  CREATE TABLE IF NOT EXISTS all_seen_aircraft (
    hex TEXT PRIMARY KEY,
    first_seen_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL DEFAULT 0
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS registrations (
    registration TEXT PRIMARY KEY,
    type_code TEXT,
    airline_icao TEXT,
    first_seen_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    times_seen INTEGER NOT NULL DEFAULT 1
  )
`);

// All-time distinct flight/callsign strings ever seen -- same shape and
// purpose as seen_aircraft above, just keyed by callsign instead of hex, for
// the Stats "unique flights" tile. Bounded the same way registrations is:
// distinct callsigns a home receiver will ever observe, not raw per-message
// history. last_seen_at (added alongside the range-scoped Stats summary,
// mirroring registrations' own column) is what makes "unique flights in the
// last 7 days" -- not just "ever" or "today" -- answerable at all; without
// it there was no way to tell whether a callsign first seen months ago was
// also active within some arbitrary recent window.
db.exec(`
  CREATE TABLE IF NOT EXISTS seen_flights (
    flight TEXT PRIMARY KEY,
    first_seen_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL DEFAULT 0
  )
`);

// Migration: installs from before the advanced-stats feature have a
// daily_stats table without these columns. CREATE TABLE IF NOT EXISTS above
// is a no-op on an existing table, so missing columns need an explicit
// ALTER TABLE -- SQLite only allows adding one column per statement.
const DAILY_STATS_NEW_COLUMNS = [
  ['avg_aircraft', 'REAL NOT NULL DEFAULT 0'],
  ['avg_with_pos', 'REAL NOT NULL DEFAULT 0'],
  ['max_with_pos', 'INTEGER NOT NULL DEFAULT 0'],
  ['avg_without_pos', 'REAL NOT NULL DEFAULT 0'],
  ['max_without_pos', 'INTEGER NOT NULL DEFAULT 0'],
  ['range_top_avg_km', 'REAL NOT NULL DEFAULT 0'],
  ['unique_aircraft_count', 'INTEGER NOT NULL DEFAULT 0'],
  ['unique_flights_count', 'INTEGER NOT NULL DEFAULT 0'],
];
const existingColumns = new Set(db.prepare('PRAGMA table_info(daily_stats)').all().map((col) => col.name));
for (const [name, definition] of DAILY_STATS_NEW_COLUMNS) {
  if (!existingColumns.has(name)) {
    db.exec(`ALTER TABLE daily_stats ADD COLUMN ${name} ${definition}`);
  }
}

// Same migration shape as DAILY_STATS_NEW_COLUMNS above, generalized: adds
// a column to an existing table if it isn't already there. Installs from
// before the range-scoped Stats summary have a seen_flights/seen_aircraft
// table with no last_seen_at column.
function ensureColumn(table, name, definition) {
  const existing = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((col) => col.name));
  if (!existing.has(name)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  }
}
ensureColumn('seen_flights', 'last_seen_at', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('seen_aircraft', 'last_seen_at', 'INTEGER NOT NULL DEFAULT 0');

export function getConfig(key) {
  const row = db.prepare('SELECT value FROM config WHERE key = ?').get(key);
  return row ? row.value : null;
}

export function setConfig(key, value) {
  db.prepare(
    'INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, value);
}

export function deleteConfig(key) {
  db.prepare('DELETE FROM config WHERE key = ?').run(key);
}

// Every row in `config` as a plain {key: rawValue} object, values left as
// the raw TEXT column content -- some keys store a JSON blob (notification
// settings, watch list, smart-home settings...), others a plain string
// (home lat/lon, ntfy topic, port...), and this is generic over both:
// config-backup.js's export/import round-trips the raw string either way
// without needing to know which keys are which.
export function getAllConfigEntries() {
  const rows = db.prepare('SELECT key, value FROM config').all();
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

export function upsertDailyStats(
  date,
  {
    maxAircraft,
    totalMessages,
    maxRangeKm,
    avgAircraft = 0,
    avgWithPos = 0,
    maxWithPos = 0,
    avgWithoutPos = 0,
    maxWithoutPos = 0,
    rangeTopAvgKm = 0,
    uniqueAircraftCount = 0,
    uniqueFlightsCount = 0,
  },
) {
  db.prepare(`
    INSERT INTO daily_stats (
      date, max_aircraft, total_messages, max_range_km,
      avg_aircraft, avg_with_pos, max_with_pos, avg_without_pos, max_without_pos, range_top_avg_km,
      unique_aircraft_count, unique_flights_count,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(date) DO UPDATE SET
      max_aircraft = excluded.max_aircraft,
      total_messages = excluded.total_messages,
      max_range_km = excluded.max_range_km,
      avg_aircraft = excluded.avg_aircraft,
      avg_with_pos = excluded.avg_with_pos,
      max_with_pos = excluded.max_with_pos,
      avg_without_pos = excluded.avg_without_pos,
      max_without_pos = excluded.max_without_pos,
      range_top_avg_km = excluded.range_top_avg_km,
      unique_aircraft_count = excluded.unique_aircraft_count,
      unique_flights_count = excluded.unique_flights_count,
      updated_at = excluded.updated_at
  `).run(
    date,
    maxAircraft,
    totalMessages,
    maxRangeKm,
    avgAircraft,
    avgWithPos,
    maxWithPos,
    avgWithoutPos,
    maxWithoutPos,
    rangeTopAvgKm,
    uniqueAircraftCount,
    uniqueFlightsCount,
    Date.now(),
  );
}

export function getDailyStats(date) {
  return db.prepare('SELECT * FROM daily_stats WHERE date = ?').get(date) ?? null;
}

export function getAllDailyStats() {
  return db.prepare('SELECT * FROM daily_stats ORDER BY date ASC').all();
}

// The install's own "day one", used to pick chart bucket granularity from
// how much history actually exists rather than from the range's name
// (see time-buckets.js's granularityForRange). null on a brand-new install
// whose first daily_stats row hasn't been flushed yet.
export function getEarliestDailyStatsDate() {
  const row = db.prepare('SELECT MIN(date) AS date FROM daily_stats').get();
  return row?.date ?? null;
}

export function getDailyStatsSince(date) {
  return db.prepare('SELECT * FROM daily_stats WHERE date >= ? ORDER BY date ASC').all(date);
}

export function getConfigJSON(key, fallback) {
  const raw = getConfig(key);
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function setConfigJSON(key, value) {
  setConfig(key, JSON.stringify(value));
}

// Runs fn() inside one transaction -- shared by the batched upsert
// functions below (hard rule 5: no per-row writes scattered through the
// poll loop, one commit per periodic flush instead). Exported and reentrant
// via SAVEPOINT: node:sqlite's DatabaseSync throws on a nested BEGIN, but
// index.js's flushDailyStats calls upsertDailyStats plus four flushDirtyX()
// functions together as one periodic flush tick, each of which reaches one
// of the upsert* functions below that call this on their own -- depth
// tracks how many runBatch calls are currently nested, so only the
// outermost caller opens/closes the real transaction (previously five
// separate commits per flush tick) while every call still commits or rolls
// back correctly on its own if used standalone, exactly as before.
let transactionDepth = 0;

export function runBatch(fn) {
  const isOutermost = transactionDepth === 0;
  transactionDepth += 1;
  if (isOutermost) db.exec('BEGIN');
  else db.exec(`SAVEPOINT sp${transactionDepth}`);
  try {
    fn();
    if (isOutermost) db.exec('COMMIT');
    else db.exec(`RELEASE sp${transactionDepth}`);
  } catch (err) {
    if (isOutermost) db.exec('ROLLBACK');
    else db.exec(`ROLLBACK TO sp${transactionDepth}`);
    throw err;
  } finally {
    transactionDepth -= 1;
  }
}

// Raw read/write pairs for the three seen-tracker.js-backed caches
// (seen-flights.js, aircraft-tracked.js, aircraft-seen.js) -- same shape
// as getAllRegistrations/upsertRegistrations below, just without the
// typeCode/airlineIcao/timesSeen fields those carry.
export function getAllSeenFlights() {
  return db.prepare('SELECT * FROM seen_flights').all();
}

const upsertSeenFlightStmt = db.prepare(`
  INSERT INTO seen_flights (flight, first_seen_at, last_seen_at) VALUES (?, ?, ?)
  ON CONFLICT(flight) DO UPDATE SET last_seen_at = excluded.last_seen_at
`);

export function upsertSeenFlights(entries) {
  if (entries.length === 0) return;
  runBatch(() => {
    for (const entry of entries) upsertSeenFlightStmt.run(entry.flight, entry.firstSeenAt, entry.lastSeenAt);
  });
}

export function getAllSeenAircraft() {
  return db.prepare('SELECT * FROM seen_aircraft').all();
}

const upsertSeenAircraftStmt = db.prepare(`
  INSERT INTO seen_aircraft (hex, first_seen_at, last_seen_at) VALUES (?, ?, ?)
  ON CONFLICT(hex) DO UPDATE SET last_seen_at = excluded.last_seen_at
`);

export function upsertSeenAircraft(entries) {
  if (entries.length === 0) return;
  runBatch(() => {
    for (const entry of entries) upsertSeenAircraftStmt.run(entry.hex, entry.firstSeenAt, entry.lastSeenAt);
  });
}

export function getAllAircraftSeenRaw() {
  return db.prepare('SELECT * FROM all_seen_aircraft').all();
}

const upsertAircraftSeenRawStmt = db.prepare(`
  INSERT INTO all_seen_aircraft (hex, first_seen_at, last_seen_at) VALUES (?, ?, ?)
  ON CONFLICT(hex) DO UPDATE SET last_seen_at = excluded.last_seen_at
`);

export function upsertAircraftSeenRaw(entries) {
  if (entries.length === 0) return;
  runBatch(() => {
    for (const entry of entries) upsertAircraftSeenRawStmt.run(entry.hex, entry.firstSeenAt, entry.lastSeenAt);
  });
}

const upsertRegistrationStmt = db.prepare(`
  INSERT INTO registrations (registration, type_code, airline_icao, first_seen_at, last_seen_at, times_seen)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(registration) DO UPDATE SET
    type_code = excluded.type_code,
    airline_icao = excluded.airline_icao,
    last_seen_at = excluded.last_seen_at,
    times_seen = excluded.times_seen
`);

export function upsertRegistration(registration, { typeCode, airlineIcao, firstSeenAt, lastSeenAt, timesSeen }) {
  upsertRegistrationStmt.run(registration, typeCode ?? null, airlineIcao ?? null, firstSeenAt, lastSeenAt, timesSeen);
}

// Batched in one transaction -- called periodically with every registration
// that changed since the last flush (hard rule 5: batch writes, no per-row
// inserts scattered through the poll loop).
export function upsertRegistrations(entries) {
  if (entries.length === 0) return;
  runBatch(() => {
    for (const entry of entries) {
      upsertRegistration(entry.registration, entry);
    }
  });
}

export function getRegistration(registration) {
  return db.prepare('SELECT * FROM registrations WHERE registration = ?').get(registration) ?? null;
}

export function getAllRegistrations() {
  return db.prepare('SELECT * FROM registrations ORDER BY last_seen_at DESC').all();
}

export function getRegistrationsSince(sinceMs) {
  return db.prepare('SELECT * FROM registrations WHERE last_seen_at >= ? ORDER BY last_seen_at DESC').all(sinceMs);
}

// Merge-safe row writers used by exactly one caller: config-backup.js's
// restore path. Every upsert* function above is deliberately NOT reusable
// here, and each in its own data-losing way:
//
//   - the three seen tables set last_seen_at = excluded.last_seen_at, so
//     restoring an older backup would move a live "last seen" *backwards*,
//     and none of them touch first_seen_at at all -- discarding precisely
//     the oldest-sighting history a backup exists to preserve.
//   - upsertRegistration overwrites times_seen with the backup's (possibly
//     smaller) count, and overwrites a live non-null type_code/airline_icao
//     with a null from an older backup that hadn't resolved it yet.
//   - upsertDailyStats always stamps updated_at = Date.now(), so it cannot
//     express "leave this row alone, the live one is fresher".
//
// So the restore path merges instead: oldest first_seen_at wins, newest
// last_seen_at wins, the higher times_seen wins, and a null never clobbers
// a known value. On a fresh install (empty database -- the headline
// "reinstall the SD card" case) these behave identically to the plain
// upserts; the difference only shows up when importing into a database that
// already has rows, which is exactly the case the merge-not-replace decision
// committed us to.
//
// daily_stats merges whole-row newest-wins rather than per-column max()
// because a row's averages (avg_aircraft, avg_with_pos) are only meaningful
// alongside the maxima from the same accumulator -- mixing columns from two
// different runs would produce a day that never actually happened.
const importRowWriters = {
  daily_stats: {
    stmt: db.prepare(`
      INSERT INTO daily_stats (
        date, max_aircraft, total_messages, max_range_km,
        avg_aircraft, avg_with_pos, max_with_pos, avg_without_pos, max_without_pos, range_top_avg_km,
        unique_aircraft_count, unique_flights_count,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(date) DO UPDATE SET
        max_aircraft = excluded.max_aircraft,
        total_messages = excluded.total_messages,
        max_range_km = excluded.max_range_km,
        avg_aircraft = excluded.avg_aircraft,
        avg_with_pos = excluded.avg_with_pos,
        max_with_pos = excluded.max_with_pos,
        avg_without_pos = excluded.avg_without_pos,
        max_without_pos = excluded.max_without_pos,
        range_top_avg_km = excluded.range_top_avg_km,
        unique_aircraft_count = excluded.unique_aircraft_count,
        unique_flights_count = excluded.unique_flights_count,
        updated_at = excluded.updated_at
      WHERE excluded.updated_at > daily_stats.updated_at
    `),
    bind: (row) => [
      row.date,
      row.maxAircraft,
      row.totalMessages,
      row.maxRangeKm,
      row.avgAircraft,
      row.avgWithPos,
      row.maxWithPos,
      row.avgWithoutPos,
      row.maxWithoutPos,
      row.rangeTopAvgKm,
      row.uniqueAircraftCount,
      row.uniqueFlightsCount,
      row.updatedAt,
    ],
  },
  seen_aircraft: {
    stmt: db.prepare(`
      INSERT INTO seen_aircraft (hex, first_seen_at, last_seen_at) VALUES (?, ?, ?)
      ON CONFLICT(hex) DO UPDATE SET
        first_seen_at = min(seen_aircraft.first_seen_at, excluded.first_seen_at),
        last_seen_at = max(seen_aircraft.last_seen_at, excluded.last_seen_at)
    `),
    bind: (row) => [row.hex, row.firstSeenAt, row.lastSeenAt],
  },
  all_seen_aircraft: {
    stmt: db.prepare(`
      INSERT INTO all_seen_aircraft (hex, first_seen_at, last_seen_at) VALUES (?, ?, ?)
      ON CONFLICT(hex) DO UPDATE SET
        first_seen_at = min(all_seen_aircraft.first_seen_at, excluded.first_seen_at),
        last_seen_at = max(all_seen_aircraft.last_seen_at, excluded.last_seen_at)
    `),
    bind: (row) => [row.hex, row.firstSeenAt, row.lastSeenAt],
  },
  seen_flights: {
    stmt: db.prepare(`
      INSERT INTO seen_flights (flight, first_seen_at, last_seen_at) VALUES (?, ?, ?)
      ON CONFLICT(flight) DO UPDATE SET
        first_seen_at = min(seen_flights.first_seen_at, excluded.first_seen_at),
        last_seen_at = max(seen_flights.last_seen_at, excluded.last_seen_at)
    `),
    bind: (row) => [row.flight, row.firstSeenAt, row.lastSeenAt],
  },
  registrations: {
    stmt: db.prepare(`
      INSERT INTO registrations (registration, type_code, airline_icao, first_seen_at, last_seen_at, times_seen)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(registration) DO UPDATE SET
        type_code = coalesce(excluded.type_code, registrations.type_code),
        airline_icao = coalesce(excluded.airline_icao, registrations.airline_icao),
        first_seen_at = min(registrations.first_seen_at, excluded.first_seen_at),
        last_seen_at = max(registrations.last_seen_at, excluded.last_seen_at),
        times_seen = max(registrations.times_seen, excluded.times_seen)
    `),
    bind: (row) => [
      row.registration,
      row.typeCode ?? null,
      row.airlineIcao ?? null,
      row.firstSeenAt,
      row.lastSeenAt,
      row.timesSeen,
    ],
  },
};

// Whitelist lookup, never dynamic SQL: `table` comes from config-backup.js's
// TABLE_SPECS, and an unknown name throws rather than reaching the database.
// Wrapped in runBatch so a restore of one table is one commit; the caller
// wraps the whole import in an outer runBatch, which SAVEPOINT-nests.
// Returns how many rows were actually written, not how many were offered:
// the daily_stats merge has a WHERE clause that can legitimately decline a
// row (the live one is fresher), and reporting the input length would let
// the UI claim it restored something it didn't.
export function importRows(table, entries) {
  if (!Object.hasOwn(importRowWriters, table)) throw new Error(`Unknown table for import: ${table}`);
  const writer = importRowWriters[table];
  if (entries.length === 0) return 0;
  let applied = 0;
  runBatch(() => {
    for (const entry of entries) applied += writer.stmt.run(...writer.bind(entry)).changes;
  });
  return applied;
}

// One row per airline ICAO code actually seen, aggregated straight from the
// registrations table -- no separate airlines table needed, this is exactly
// the same data the "most common airline" chart already reads, just grouped
// differently. Registrations with no resolved airline (military/GA/unmatched
// callsigns) are excluded, same as the doughnut chart. Airline names
// themselves come from /api/airlines (OpenFlights data) and are resolved
// client-side, same as the existing registrations table.
// One row per airline, so this is bounded by how many airlines exist (a
// few hundred), not by how many airframes the receiver has seen -- unlike
// the registrations table, the *size* of this result was never the problem.
// It is paged server-side anyway, purely so both Stats tables share one
// client-side code path.
export function getAllAirlinesSummary() {
  return db
    .prepare(
      `SELECT
        airline_icao AS airlineIcao,
        COUNT(*) AS registrationsCount,
        SUM(times_seen) AS totalTimesSeen,
        MIN(first_seen_at) AS firstSeenAt,
        MAX(last_seen_at) AS lastSeenAt
      FROM registrations
      WHERE airline_icao IS NOT NULL
      GROUP BY airline_icao
      ORDER BY registrationsCount DESC`,
    )
    .all();
}
