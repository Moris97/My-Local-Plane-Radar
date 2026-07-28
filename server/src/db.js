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

db.exec(`
  CREATE TABLE IF NOT EXISTS seen_aircraft (
    hex TEXT PRIMARY KEY,
    first_seen_at INTEGER NOT NULL
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
// the Stats "unique flights seen" counters. Bounded the same way
// registrations is: distinct callsigns a home receiver will ever observe,
// not raw per-message history.
db.exec(`
  CREATE TABLE IF NOT EXISTS seen_flights (
    flight TEXT PRIMARY KEY,
    first_seen_at INTEGER NOT NULL
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

export function hasSeenAircraft(hex) {
  return db.prepare('SELECT 1 FROM seen_aircraft WHERE hex = ?').get(hex) !== undefined;
}

export function markAircraftSeen(hex) {
  db.prepare('INSERT OR IGNORE INTO seen_aircraft (hex, first_seen_at) VALUES (?, ?)').run(hex, Date.now());
}

// All-time distinct aircraft ever seen -- the "Ilość widzianych samolotów"
// tile in Stats' "Od początku" section. seen_aircraft already exists for
// first-seen notifications; this just counts it.
export function getSeenAircraftCount() {
  return db.prepare('SELECT COUNT(*) AS count FROM seen_aircraft').get().count;
}

export function hasSeenFlight(flight) {
  return db.prepare('SELECT 1 FROM seen_flights WHERE flight = ?').get(flight) !== undefined;
}

export function markFlightSeen(flight) {
  db.prepare('INSERT OR IGNORE INTO seen_flights (flight, first_seen_at) VALUES (?, ?)').run(flight, Date.now());
}

export function getSeenFlightsCount() {
  return db.prepare('SELECT COUNT(*) AS count FROM seen_flights').get().count;
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

// All-time distinct registrations ever seen -- "unikalnych rejestracji" in
// Stats' "Od początku" section.
export function getRegistrationsCount() {
  return db.prepare('SELECT COUNT(*) AS count FROM registrations').get().count;
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
