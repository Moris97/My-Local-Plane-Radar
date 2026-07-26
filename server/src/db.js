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
    updated_at INTEGER NOT NULL
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS seen_aircraft (
    hex TEXT PRIMARY KEY,
    first_seen_at INTEGER NOT NULL
  )
`);

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

export function upsertDailyStats(date, { maxAircraft, totalMessages, maxRangeKm }) {
  db.prepare(`
    INSERT INTO daily_stats (date, max_aircraft, total_messages, max_range_km, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(date) DO UPDATE SET
      max_aircraft = excluded.max_aircraft,
      total_messages = excluded.total_messages,
      max_range_km = excluded.max_range_km,
      updated_at = excluded.updated_at
  `).run(date, maxAircraft, totalMessages, maxRangeKm, Date.now());
}

export function getDailyStats(date) {
  return db.prepare('SELECT * FROM daily_stats WHERE date = ?').get(date) ?? null;
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
