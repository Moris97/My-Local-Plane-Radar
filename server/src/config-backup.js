import { getAllConfigEntries, setConfig } from './db.js';

// A full backup/restore of everything in SQLite's `config` table --
// notification settings, watch list, smart-home broker settings, ntfy
// topic, receiver home location override, server port override, and the
// Settings password hash. Deliberately generic over the mix of raw-string
// and JSON-blob values that table already holds (see db.js's
// getAllConfigEntries) rather than needing to know each key's shape:
// export/import both treat every value as an opaque string and round-trip
// it byte-for-byte, so this doesn't need updating every time a new config
// key is added elsewhere.
//
// Exists because hard rule 4 (no raw position history in SQLite) already
// keeps this table small, but a Pi's SD card can still fail outright --
// there was no way to get this config back except retyping it by hand.
const EXPORT_VERSION = 1;

export function exportConfig() {
  return {
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    config: getAllConfigEntries(),
  };
}

// Merges into the existing config rather than replacing the table
// wholesale: a key absent from an older export (e.g. one taken before a
// newer MLPR version added a new setting) is left untouched instead of
// being wiped out.
export function importConfig(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, error: 'Not a valid MLPR config export' };
  }
  const { config } = data;
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return { ok: false, error: 'Not a valid MLPR config export' };
  }

  const entries = Object.entries(config);
  for (const [key, value] of entries) {
    // `__proto__` can't actually reach Object.prototype via a plain
    // Object.entries()-sourced key (it's own-enumerable data here, not the
    // prototype link), but rejecting it costs nothing and removes any
    // doubt -- same defense-in-depth spirit as escaping HTML that's
    // "probably" already safe.
    if (key === '__proto__' || typeof value !== 'string') {
      return { ok: false, error: `Invalid entry for key "${key}"` };
    }
  }

  for (const [key, value] of entries) setConfig(key, value);
  return { ok: true, importedKeys: entries.map(([key]) => key) };
}
