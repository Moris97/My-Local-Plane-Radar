import { upsertRegistrations, getAllRegistrations } from './db.js';
import { bucketize } from './time-buckets.js';

// Less than this gap since the last contact = still the same "visit" (e.g.
// briefly dropping out of range and coming back); at or beyond it, the
// aircraft counts as seen again (e.g. it landed, turned around, came back).
const VISIT_GAP_MS = 15 * 60 * 1000;

// In-memory cache, mirrored to and from the `registrations` SQLite table.
// Same shape as trail-history.js/stats-history.js: mutate in memory on every
// poll tick, flush dirty entries in one batched transaction periodically
// (hard rule 5) rather than writing per-sighting.
const cache = new Map();
let loaded = false;

function ensureLoaded() {
  if (loaded) return;
  loaded = true;
  for (const row of getAllRegistrations()) {
    cache.set(row.registration, {
      typeCode: row.type_code,
      airlineIcao: row.airline_icao,
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
      timesSeen: row.times_seen,
      dirty: false,
    });
  }
}

export function recordSighting(registration, { typeCode, airlineIcao } = {}, now = Date.now()) {
  ensureLoaded();
  const entry = cache.get(registration);

  if (!entry) {
    cache.set(registration, {
      typeCode: typeCode ?? null,
      airlineIcao: airlineIcao ?? null,
      firstSeenAt: now,
      lastSeenAt: now,
      timesSeen: 1,
      dirty: true,
    });
    return;
  }

  if (now - entry.lastSeenAt >= VISIT_GAP_MS) {
    entry.timesSeen += 1;
  }
  entry.lastSeenAt = now;
  if (typeCode) entry.typeCode = typeCode;
  if (airlineIcao) entry.airlineIcao = airlineIcao;
  entry.dirty = true;
}

export function flushDirtyRegistrations() {
  ensureLoaded();
  const dirty = [];
  for (const [registration, entry] of cache) {
    if (!entry.dirty) continue;
    dirty.push({
      registration,
      typeCode: entry.typeCode,
      airlineIcao: entry.airlineIcao,
      firstSeenAt: entry.firstSeenAt,
      lastSeenAt: entry.lastSeenAt,
      timesSeen: entry.timesSeen,
    });
    entry.dirty = false;
  }
  upsertRegistrations(dirty);
  return dirty.length;
}

export function getRegistrationsList() {
  ensureLoaded();
  return Array.from(cache.entries()).map(([registration, e]) => ({
    registration,
    typeCode: e.typeCode,
    airlineIcao: e.airlineIcao,
    firstSeenAt: e.firstSeenAt,
    lastSeenAt: e.lastSeenAt,
    timesSeen: e.timesSeen,
  }));
}

// "Seen during the range" = last contact at or after sinceMs (0 = since the
// beginning, no filtering).
function activeSince(sinceMs) {
  ensureLoaded();
  return Array.from(cache.values()).filter((e) => e.lastSeenAt >= sinceMs);
}

export function getTypeCounts(sinceMs) {
  const counts = new Map();
  for (const entry of activeSince(sinceMs)) {
    if (!entry.typeCode) continue;
    counts.set(entry.typeCode, (counts.get(entry.typeCode) ?? 0) + 1);
  }
  return Array.from(counts, ([typeCode, count]) => ({ typeCode, count })).sort((a, b) => b.count - a.count);
}

export function getAirlineCounts(sinceMs) {
  const counts = new Map();
  for (const entry of activeSince(sinceMs)) {
    if (!entry.airlineIcao) continue;
    counts.set(entry.airlineIcao, (counts.get(entry.airlineIcao) ?? 0) + 1);
  }
  return Array.from(counts, ([airlineIcao, count]) => ({ airlineIcao, count })).sort((a, b) => b.count - a.count);
}

export function getNewRegistrationsBuckets(sinceMs, granularity) {
  ensureLoaded();
  const items = Array.from(cache.values()).filter((e) => e.firstSeenAt >= sinceMs);
  return bucketize(items, {
    getTime: (e) => e.firstSeenAt,
    getValue: () => 1,
    granularity,
    reducer: (values) => ({ count: values.length }),
  });
}

export function resetRegistrationsCache() {
  cache.clear();
  loaded = false;
}
