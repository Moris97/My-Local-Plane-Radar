import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultDataDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data');
const dbPath = process.env.MLPR_DB_PATH ?? join(defaultDataDir, 'mlpr.db');
mkdirSync(dirname(dbPath), { recursive: true });

const db = new DatabaseSync(dbPath);

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
// poll loop, one commit per periodic flush instead).
function runBatch(fn) {
  db.exec('BEGIN');
  try {
    fn();
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
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
  db.exec('BEGIN');
  try {
    for (const entry of entries) {
      upsertRegistration(entry.registration, entry);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
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

// One row per airline ICAO code actually seen, aggregated straight from the
// registrations table -- no separate airlines table needed, this is exactly
// the same data the "most common airline" chart already reads, just grouped
// differently. Registrations with no resolved airline (military/GA/unmatched
// callsigns) are excluded, same as the doughnut chart. Airline names
// themselves come from /api/airlines (OpenFlights data) and are resolved
// client-side, same as the existing registrations table.
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
