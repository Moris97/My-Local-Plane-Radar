import {
  getAllConfigEntries,
  setConfig,
  runBatch,
  importRows,
  getAllDailyStats,
  getAllSeenAircraft,
  getAllAircraftSeenRaw,
  getAllSeenFlights,
  getAllRegistrations,
} from './db.js';

// A full backup/restore of this install: everything in SQLite's `config`
// table (notification settings, watch list, smart-home broker settings,
// ntfy topic, receiver home override, server port override, the Settings
// password hash, the antenna coverage blob) *plus* the five history tables
// that hold months of accumulated observations and cannot be recreated from
// anything else -- daily stats, every aircraft/callsign/registration ever
// seen.
//
// The point is a real "move the SD card" story: export, reinstall the OS,
// import, and the install is where it was. That is also why import merges
// by primary key rather than replacing tables: restoring an older backup
// must never delete rows or move a live "last seen" backwards.
//
// The two halves of this file have deliberately different maintenance
// costs, and it matters to keep them apart:
//
//   - the `config` half stays GENERIC over that table (see db.js's
//     getAllConfigEntries): every value is an opaque string, round-tripped
//     byte-for-byte, so adding a new config key anywhere in the app needs
//     no change here, exactly as before.
//   - the `tables` half is an explicit per-column spec, so adding a column
//     to daily_stats DOES need one line added below -- the same cost, in
//     the same shape, as db.js's own DAILY_STATS_NEW_COLUMNS list.

const EXPORT_VERSION = 2;

// Rows are exported with camelCase names rather than the raw SQL column
// names, so the file format is decoupled from the schema (a future column
// rename doesn't invalidate existing backups) and the names already line up
// with what db.js's importRows binder expects.
//
// Field entries are [jsonName, type]. The first field of each spec is the
// table's primary key and is validated strictly; the rest tolerate being
// absent (a number falls back to 0, matching the columns' own DEFAULT 0,
// and a nullable string to null) but never tolerate being present with the
// wrong type.
const TABLE_SPECS = [
  {
    name: 'dailyStats',
    sqlTable: 'daily_stats',
    read: getAllDailyStats,
    fields: [
      ['date', 'string'],
      ['maxAircraft', 'number'],
      ['totalMessages', 'number'],
      ['maxRangeKm', 'number'],
      ['avgAircraft', 'number'],
      ['avgWithPos', 'number'],
      ['maxWithPos', 'number'],
      ['avgWithoutPos', 'number'],
      ['maxWithoutPos', 'number'],
      ['rangeTopAvgKm', 'number'],
      ['uniqueAircraftCount', 'number'],
      ['uniqueFlightsCount', 'number'],
      ['updatedAt', 'number'],
    ],
    // SQL column name per field, same order -- only needed on the export
    // side, since importRows binds by camelCase name.
    columns: [
      'date',
      'max_aircraft',
      'total_messages',
      'max_range_km',
      'avg_aircraft',
      'avg_with_pos',
      'max_with_pos',
      'avg_without_pos',
      'max_without_pos',
      'range_top_avg_km',
      'unique_aircraft_count',
      'unique_flights_count',
      'updated_at',
    ],
  },
  {
    name: 'seenAircraft',
    sqlTable: 'seen_aircraft',
    read: getAllSeenAircraft,
    fields: [
      ['hex', 'string'],
      ['firstSeenAt', 'number'],
      ['lastSeenAt', 'number'],
    ],
    columns: ['hex', 'first_seen_at', 'last_seen_at'],
  },
  {
    name: 'allSeenAircraft',
    sqlTable: 'all_seen_aircraft',
    read: getAllAircraftSeenRaw,
    fields: [
      ['hex', 'string'],
      ['firstSeenAt', 'number'],
      ['lastSeenAt', 'number'],
    ],
    columns: ['hex', 'first_seen_at', 'last_seen_at'],
  },
  {
    name: 'seenFlights',
    sqlTable: 'seen_flights',
    read: getAllSeenFlights,
    fields: [
      ['flight', 'string'],
      ['firstSeenAt', 'number'],
      ['lastSeenAt', 'number'],
    ],
    columns: ['flight', 'first_seen_at', 'last_seen_at'],
  },
  {
    name: 'registrations',
    sqlTable: 'registrations',
    read: getAllRegistrations,
    fields: [
      ['registration', 'string'],
      ['typeCode', 'string?'],
      ['airlineIcao', 'string?'],
      ['firstSeenAt', 'number'],
      ['lastSeenAt', 'number'],
      ['timesSeen', 'number'],
    ],
    columns: ['registration', 'type_code', 'airline_icao', 'first_seen_at', 'last_seen_at', 'times_seen'],
  },
];

const SPECS_BY_NAME = new Map(TABLE_SPECS.map((spec) => [spec.name, spec]));

// Rows are yielded in batches rather than one giant JSON.stringify so no
// single fragment is more than a couple of hundred KB.
const EXPORT_BATCH_ROWS = 2000;

// A browser-settings section that fails this is dropped, not treated as a
// fatal import error -- a malformed per-browser blob must never block
// restoring the actual server data.
const MAX_BROWSER_SETTINGS_BYTES = 64 * 1024;

function toJsonRow(spec, row) {
  const out = {};
  for (let i = 0; i < spec.fields.length; i += 1) {
    out[spec.fields[i][0]] = row[spec.columns[i]] ?? null;
  }
  return out;
}

// The whole backup as a stream of JSON string fragments. Yielded in
// batches so the consumer (backup-file.js's gzipChunkStream) gets a chance
// to run the event loop between them -- see that file for the measurements
// showing why that, rather than memory, is what streaming buys here.
//
// Each table is still read whole (spec.read()) rather than iterated with a
// live SQLite cursor. That is deliberate: an open cursor held across the
// export's await points would be reading a table the 1 Hz poll loop and the
// 45s flush are writing to, and SQLite leaves the results of a SELECT
// undefined if its table is modified mid-iteration. Materialising per table
// costs some transient memory and buys a consistent read.
//
// Key order is deliberate: metadata and the small human-interesting
// sections come first, so `gunzip -c backup.mlpr | head` shows something
// useful before the multi-megabyte tables.
export function* backupChunks({ browserSettings = null, appVersion = null } = {}) {
  yield `{"version":${EXPORT_VERSION}`;
  yield `,"exportedAt":${JSON.stringify(new Date().toISOString())}`;
  if (appVersion) yield `,"appVersion":${JSON.stringify(appVersion)}`;
  if (browserSettings) yield `,"browserSettings":${JSON.stringify(browserSettings)}`;
  yield `,"config":${JSON.stringify(getAllConfigEntries())}`;
  yield ',"tables":{';

  let firstTable = true;
  for (const spec of TABLE_SPECS) {
    yield `${firstTable ? '' : ','}${JSON.stringify(spec.name)}:[`;
    firstTable = false;

    const rows = spec.read();
    for (let start = 0; start < rows.length; start += EXPORT_BATCH_ROWS) {
      const batch = rows.slice(start, start + EXPORT_BATCH_ROWS);
      const text = batch.map((row) => JSON.stringify(toJsonRow(spec, row))).join(',');
      yield start === 0 ? text : `,${text}`;
    }
    yield ']';
  }

  yield '}}';
}

// The same payload as an object, for tests and in-process callers. Built by
// running the generator so there is only ever one implementation of the
// format -- the two can't drift apart, which matters because the generator
// places its commas by hand.
export function exportBackup(options = {}) {
  return JSON.parse([...backupChunks(options)].join(''));
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// The per-browser settings section (units, language, map theme, list
// columns...) is opt-in at export time and rides along as its own top-level
// section rather than inside `config`, which is contractually "the SQLite
// config table" and would land these in the database as bogus rows.
export function validateBrowserSettings(section) {
  if (!isPlainObject(section)) return null;
  let text;
  try {
    text = JSON.stringify(section);
  } catch {
    return null; // circular or otherwise unserialisable
  }
  if (!text || text.length > MAX_BROWSER_SETTINGS_BYTES) return null;
  if (section.settings !== undefined && !isPlainObject(section.settings)) return null;
  if (section.statsRange !== undefined && typeof section.statsRange !== 'string') return null;
  // Re-parsed rather than passed through, so anything the browser sent that
  // JSON can't represent is gone by the time it reaches the file.
  return JSON.parse(text);
}

function validateRow(spec, row, index) {
  if (!isPlainObject(row)) return { error: `Invalid row ${index} in table "${spec.name}"` };

  const out = {};
  for (let i = 0; i < spec.fields.length; i += 1) {
    const [name, type] = spec.fields[i];
    const value = row[name];
    const isKey = i === 0;

    if (isKey) {
      // The primary key is the one field with no sensible fallback, and it
      // is the value that ends up as a row identity -- rejected defensively
      // for __proto__ in the same spirit as the config keys below.
      if (typeof value !== 'string' || value.length === 0 || value === '__proto__') {
        return { error: `Invalid key "${name}" in row ${index} of table "${spec.name}"` };
      }
      out[name] = value;
      continue;
    }

    if (value === undefined || value === null) {
      // Tolerated: an older or newer file that simply doesn't carry this
      // field. Falls back to what the column itself defaults to.
      out[name] = type === 'number' ? 0 : null;
      continue;
    }
    if (type === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return { error: `Invalid "${name}" in row ${index} of table "${spec.name}"` };
      }
    } else if (typeof value !== 'string') {
      return { error: `Invalid "${name}" in row ${index} of table "${spec.name}"` };
    }
    out[name] = value;
  }

  return { row: out };
}

// Merges into the existing data rather than replacing it: a key or row
// absent from an older export (e.g. one taken before a newer MLPR version
// added a setting) is left untouched instead of being wiped out, and the
// row-level merge rules in db.js's importRows keep the oldest first-seen
// and the newest last-seen on both sides.
//
// Everything is validated before anything is written, and the writes then
// happen inside a single transaction: a half-restored install is a much
// worse outcome than a failed restore, and one commit satisfies hard rule 5.
// There is deliberately no `await` anywhere in this function -- the whole
// flush/import/reload sequence in the route is synchronous, which is what
// guarantees the 45s periodic flush can't interleave with the open
// transaction.
export function importBackup(data) {
  if (!isPlainObject(data)) {
    return { ok: false, error: 'Not a valid MLPR backup' };
  }

  // Missing version means a v1 file (the config-only format, written before
  // this field was ever checked). A file from the future is refused rather
  // than partially understood.
  const version = data.version ?? 1;
  if (!Number.isInteger(version) || version < 1) {
    return { ok: false, error: 'Not a valid MLPR backup' };
  }
  if (version > EXPORT_VERSION) {
    return { ok: false, error: 'This backup was made by a newer version of MLPR' };
  }

  const { config } = data;
  if (!isPlainObject(config)) {
    return { ok: false, error: 'Not a valid MLPR backup' };
  }

  const configEntries = Object.entries(config);
  for (const [key, value] of configEntries) {
    // `__proto__` can't actually reach Object.prototype via a plain
    // Object.entries()-sourced key (it's own-enumerable data here, not the
    // prototype link), but rejecting it costs nothing and removes any
    // doubt -- same defense-in-depth spirit as escaping HTML that's
    // "probably" already safe.
    if (key === '__proto__' || typeof value !== 'string') {
      return { ok: false, error: `Invalid entry for key "${key}"` };
    }
  }

  const pending = [];
  const skippedTables = [];
  if (data.tables !== undefined) {
    if (!isPlainObject(data.tables)) {
      return { ok: false, error: 'Not a valid MLPR backup' };
    }
    for (const [name, rows] of Object.entries(data.tables)) {
      const spec = SPECS_BY_NAME.get(name);
      if (!spec) {
        // Forward compatibility: a table this version doesn't know about is
        // skipped, but reported back rather than silently pretending the
        // whole file restored.
        skippedTables.push(name);
        continue;
      }
      if (!Array.isArray(rows)) {
        return { ok: false, error: `Table "${name}" is not a list of rows` };
      }
      const validated = new Array(rows.length);
      for (let i = 0; i < rows.length; i += 1) {
        const result = validateRow(spec, rows[i], i);
        if (result.error) return { ok: false, error: result.error };
        validated[i] = result.row;
      }
      pending.push({ spec, rows: validated });
    }
  }

  const counts = {};
  runBatch(() => {
    for (const [key, value] of configEntries) setConfig(key, value);
    for (const { spec, rows } of pending) {
      counts[spec.name] = importRows(spec.sqlTable, rows);
    }
  });

  return {
    ok: true,
    importedKeys: configEntries.map(([key]) => key),
    counts,
    skippedTables,
    // Echoed back so the browser can apply its own settings without ever
    // having to decompress the file it just uploaded.
    browserSettings: validateBrowserSettings(data.browserSettings),
  };
}
