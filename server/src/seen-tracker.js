// Shared shape behind every "distinct key ever seen, and how recently" SQLite
// table this app tracks (seen_flights, all_seen_aircraft, the confirmed
// seen_aircraft) -- in-memory cache, mutated on every poll tick, flushed to
// SQLite in one batched transaction periodically (hard rule 5: no per-row
// writes scattered through the poll loop). Extracted once a third table
// needed the exact same read-cache/write-dirty/flush/count-since machinery
// as the first two (stats-registrations.js's own cache predates this and
// has extra fields -- typeCode/airlineIcao/timesSeen -- so it stays
// separate rather than being squeezed into this narrower shape).
//
// getAllRows()/upsertRows(entries) are the table-specific persistence
// (db.js), keyed by whatever field name the caller passes as `keyField`
// (SQLite's own column name on the raw rows getAllRows returns, and the
// property name upsertRows expects on each entry it's given).
export function createSeenTracker({ getAllRows, upsertRows, keyField }) {
  const cache = new Map();
  let loaded = false;

  function ensureLoaded() {
    if (loaded) return;
    loaded = true;
    for (const row of getAllRows()) {
      cache.set(row[keyField], { firstSeenAt: row.first_seen_at, lastSeenAt: row.last_seen_at, dirty: false });
    }
  }

  function has(key) {
    ensureLoaded();
    return cache.has(key);
  }

  // Create-or-touch: the common case for a tracker with no external gate
  // (seen_flights, raw aircraft-seen) -- safe to call unconditionally every
  // tick for every currently-tracked key.
  function noteSeen(key, now = Date.now()) {
    ensureLoaded();
    const entry = cache.get(key);
    if (!entry) {
      cache.set(key, { firstSeenAt: now, lastSeenAt: now, dirty: true });
      return;
    }
    entry.lastSeenAt = now;
    entry.dirty = true;
  }

  // Advances last_seen_at for an already-existing entry only, a no-op
  // otherwise -- for a tracker whose *creation* is gated externally (e.g.
  // the confirmed-aircraft tracker, only created once the first-seen
  // notification's own delay confirms a contact), where every later tick
  // should still count as "still active" once that gate has passed.
  function touch(key, now = Date.now()) {
    ensureLoaded();
    const entry = cache.get(key);
    if (!entry) return;
    entry.lastSeenAt = now;
    entry.dirty = true;
  }

  // Explicit create for a gated tracker's own confirmation path -- a no-op
  // if the key already exists, so calling it more than once for the same
  // key is always safe.
  function create(key, now = Date.now()) {
    ensureLoaded();
    if (cache.has(key)) return;
    cache.set(key, { firstSeenAt: now, lastSeenAt: now, dirty: true });
  }

  function flush() {
    ensureLoaded();
    const dirty = [];
    for (const [key, entry] of cache) {
      if (!entry.dirty) continue;
      dirty.push({ [keyField]: key, firstSeenAt: entry.firstSeenAt, lastSeenAt: entry.lastSeenAt });
      entry.dirty = false;
    }
    upsertRows(dirty);
    return dirty.length;
  }

  // sinceMs = 0 (or omitted) is the all-time count, "ever seen" --
  // otherwise "active" (last seen at/after sinceMs).
  function getCount(sinceMs = 0) {
    ensureLoaded();
    if (sinceMs === 0) return cache.size;
    let count = 0;
    for (const entry of cache.values()) {
      if (entry.lastSeenAt >= sinceMs) count += 1;
    }
    return count;
  }

  function reset() {
    cache.clear();
    loaded = false;
  }

  return { has, noteSeen, touch, create, flush, getCount, reset };
}
