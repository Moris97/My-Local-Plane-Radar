import { upsertRegistrations, getAllRegistrations } from './db.js';
import { bucketize } from './time-buckets.js';
import { queryTable } from './stats-table.js';

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
      // The key is repeated inside the value on purpose: every read path
      // (the paged table query, the CSV export, the counts below) wants
      // whole rows, and carrying it here means they can iterate
      // cache.values() directly instead of rebuilding a row object per
      // entry on every request.
      registration: row.registration,
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
      registration,
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

function publicRow(e) {
  return {
    registration: e.registration,
    typeCode: e.typeCode,
    airlineIcao: e.airlineIcao,
    firstSeenAt: e.firstSeenAt,
    lastSeenAt: e.lastSeenAt,
    timesSeen: e.timesSeen,
  };
}

// Searched and sorted on the *resolved* airline name, not the ICAO code --
// that is what the column actually shows, so sorting it by code produced a
// name column in no visible order. airlineNameFor is injected rather than
// imported so this module stays independent of airlines-data.js (and the
// tests don't need a loaded airline file).
function tableSpec(airlineNameFor) {
  const airlineName = (e) => (e.airlineIcao ? airlineNameFor(e.airlineIcao) : '');
  return {
    searchFields: [(e) => e.registration, (e) => e.typeCode, (e) => e.airlineIcao, airlineName],
    sortFields: {
      registration: (e) => e.registration,
      typeCode: (e) => e.typeCode,
      airlineIcao: airlineName,
      firstSeenAt: (e) => e.firstSeenAt,
      lastSeenAt: (e) => e.lastSeenAt,
      timesSeen: (e) => e.timesSeen,
    },
    // "What shows up a lot" is more useful to a spotter than "what showed
    // up last"; recency is one click away.
    defaultSort: { key: 'timesSeen', dir: 'desc' },
  };
}

// Every row, unpaged. Deliberately NOT reachable from any HTTP route --
// that is exactly what queryRegistrations replaced. Kept for tests and for
// in-process callers that genuinely need the whole set.
export function getRegistrationsList() {
  ensureLoaded();
  return [...cache.values()].map(publicRow);
}

// One page of the registrations table, filtered and sorted server-side.
// Only the page itself is turned into response objects -- the filter and
// sort run over the cache's own entries.
export function queryRegistrations(params, airlineNameFor) {
  ensureLoaded();
  const result = queryTable([...cache.values()], tableSpec(airlineNameFor), params);
  return { ...result, rows: result.rows.map(publicRow) };
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

// Same bucketing as getNewRegistrationsBuckets, but split into one series
// per key (typeCode or airlineIcao) instead of one aggregate total -- feeds
// the doughnut<->line toggle on the "most common type/airline" charts: the
// line view is "new-registration trend for each of the top N", reusing the
// exact same first-seen bucketing already used for the aggregate chart
// rather than a different statistic. keyFn extracts the field to split on;
// topKeys restricts to the doughnut's own already-computed top-N list (a
// long tail of one-off types/airlines would just be visual noise as lines).
export function getNewRegistrationsBucketsByKey(sinceMs, granularity, keyFn, topKeys) {
  ensureLoaded();
  const topKeySet = new Set(topKeys);
  const items = Array.from(cache.values()).filter((e) => e.firstSeenAt >= sinceMs && topKeySet.has(keyFn(e)));

  const buckets = bucketize(items, {
    getTime: (e) => e.firstSeenAt,
    getValue: (e) => keyFn(e),
    granularity,
    reducer: (values) => {
      const counts = {};
      for (const key of topKeys) counts[key] = 0;
      for (const key of values) counts[key] += 1;
      return counts;
    },
  });

  return buckets;
}

export function resetRegistrationsCache() {
  cache.clear();
  loaded = false;
}
