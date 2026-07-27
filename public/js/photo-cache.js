// Client-side cache for Planespotters photo lookups, keyed by ICAO hex (the
// same key the API call itself uses -- one hex is one physical airframe, so
// this naturally caches "once per aircraft, not once per click"). A hit
// (a photo was found) is cached indefinitely; a miss (no photo found) is
// cached with a TTL so we occasionally retry in case Planespotters adds one
// later, instead of asking on every single panel open forever.
//
// Storage is injected (defaulting to the real browser localStorage) so this
// stays testable under plain `node --test`, which has no localStorage global.

const CACHE_KEY = 'mlpr-photo-cache';
const MISS_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Safety cap: without this, a receiver running for years could accumulate
// one entry per distinct aircraft ever inspected, unbounded. Trimmed back
// down to EVICT_TO_ENTRIES (oldest-cached-first) whenever it's exceeded.
const MAX_ENTRIES = 3000;
const EVICT_TO_ENTRIES = 2500;

function readCache(storage) {
  try {
    const raw = storage.getItem(CACHE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function writeCache(storage, cache) {
  try {
    storage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch {
    // Storage full or unavailable (e.g. private browsing) -- the cache
    // simply won't persist; still fine to hold this tick's fetch result
    // in memory via the caller's own state.
  }
}

function evictOldest(cache) {
  const keys = Object.keys(cache);
  if (keys.length <= MAX_ENTRIES) return;
  const sorted = keys.sort((a, b) => cache[a].cachedAt - cache[b].cachedAt);
  for (const key of sorted.slice(0, keys.length - EVICT_TO_ENTRIES)) {
    delete cache[key];
  }
}

// Returns { cached: false } when there's nothing usable yet (never fetched,
// or a miss whose TTL expired), or { cached: true, photo } otherwise --
// photo is null for a still-fresh cached miss.
export function getCachedPhoto(hex, storage = globalThis.localStorage, now = Date.now()) {
  const entry = readCache(storage)[hex];
  if (!entry) return { cached: false };
  if (entry.photo === null && now - entry.cachedAt > MISS_TTL_MS) return { cached: false };
  return { cached: true, photo: entry.photo };
}

// photo is the object to display, or null to record a miss.
export function setCachedPhoto(hex, photo, storage = globalThis.localStorage, now = Date.now()) {
  const cache = readCache(storage);
  cache[hex] = { photo, cachedAt: now };
  evictOldest(cache);
  writeCache(storage, cache);
}
