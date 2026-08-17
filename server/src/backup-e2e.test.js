import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { buffer as readAll } from 'node:stream/consumers';

// The headline scenario, end to end: export on one install, wipe, import on
// a completely fresh one, and prove the result matches.
//
// The "fresh install" really is a second process with its own MLPR_DB_PATH,
// not a cleared table -- db.js opens its database once at module load and
// there are deliberately no DELETE statements anywhere in the import path,
// so an in-process "wipe" would be testing something this feature doesn't
// do. A separate process with an empty database is exactly what a
// reinstalled SD card looks like.

const tmpDir = mkdtempSync(join(tmpdir(), 'mlpr-backup-e2e-'));
const sourceDbPath = join(tmpDir, 'source.db');
const freshDbPath = join(tmpDir, 'fresh.db');
const backupPath = join(tmpDir, 'backup.mlpr');
const roundTripPath = join(tmpDir, 'roundtrip.json');

process.env.MLPR_DB_PATH = sourceDbPath;

const { backupChunks, exportBackup, importBackup } = await import('./config-backup.js');
const { gzipChunkStream } = await import('./backup-file.js');
const { setConfig, setConfigJSON } = await import('./db.js');

after(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// getAll* use different ORDER BY clauses per table (registrations is by
// last_seen_at DESC, the seen tables are unordered), so a round-trip
// comparison has to sort both sides by primary key first.
const PRIMARY_KEYS = {
  dailyStats: 'date',
  seenAircraft: 'hex',
  allSeenAircraft: 'hex',
  seenFlights: 'flight',
  registrations: 'registration',
};

function normalize(dump) {
  const tables = {};
  for (const [name, rows] of Object.entries(dump.tables)) {
    const key = PRIMARY_KEYS[name];
    tables[name] = [...rows].sort((a, b) => String(a[key]).localeCompare(String(b[key])));
  }
  return { version: dump.version, config: dump.config, tables };
}

test('a full backup survives export -> a brand new empty database -> import', async () => {
  // --- Seed the "source" install -----------------------------------------
  setConfig('homeLat', '50');
  setConfig('homeLon', '20');
  setConfig('ntfyTopic', 'abcd2345');
  setConfigJSON('watchList', [{ id: '1', matchType: 'type', matchValue: 'A388', area: null }]);
  setConfigJSON('notificationSettings', { squawkEnabled: true, circlingEnabled: false });
  // Stands in for the antenna coverage blob -- by far the largest config row
  // on a real install, and the one most worth proving survives intact.
  setConfigJSON('antennaStats', { cells: Array.from({ length: 40 }, (_, i) => [[123.45 + i, `hex${i}`]]) });

  const ROWS = 1000;
  importBackup({
    config: {},
    tables: {
      // Distinct dates, deliberately spanning a month boundary -- reusing a
      // date would silently collapse rows via the primary key and make the
      // count assertion below meaningless.
      dailyStats: Array.from({ length: 40 }, (_, i) => ({
        date: new Date(Date.UTC(2026, 2, 1 + i)).toISOString().slice(0, 10),
        maxAircraft: 50 + i,
        totalMessages: 1000 * i,
        maxRangeKm: 300 + i,
        avgAircraft: 12.5,
        uniqueAircraftCount: 200 + i,
        updatedAt: 1_700_000_000_000 + i,
      })),
      seenAircraft: Array.from({ length: ROWS }, (_, i) => ({
        hex: `a${String(i).padStart(5, '0')}`, firstSeenAt: 1000 + i, lastSeenAt: 5000 + i,
      })),
      allSeenAircraft: Array.from({ length: ROWS }, (_, i) => ({
        hex: `b${String(i).padStart(5, '0')}`, firstSeenAt: 1000 + i, lastSeenAt: 5000 + i,
      })),
      seenFlights: Array.from({ length: ROWS }, (_, i) => ({
        flight: `FLT${String(i).padStart(4, '0')}`, firstSeenAt: 1000 + i, lastSeenAt: 5000 + i,
      })),
      registrations: Array.from({ length: ROWS }, (_, i) => ({
        registration: `SP-${String(i).padStart(4, '0')}`,
        typeCode: i % 3 === 0 ? null : 'B738',
        airlineIcao: i % 5 === 0 ? null : 'LOT',
        firstSeenAt: 1000 + i,
        lastSeenAt: 5000 + i,
        timesSeen: (i % 17) + 1,
      })),
    },
  });

  // --- Export it as a real .mlpr -----------------------------------------
  const bytes = await readAll(gzipChunkStream(backupChunks({ appVersion: '9.9.9' })));
  writeFileSync(backupPath, bytes);

  assert.deepEqual([bytes[0], bytes[1]], [0x1f, 0x8b], 'the file really is gzip');
  const uncompressedSize = [...backupChunks()].join('').length;
  assert.ok(
    bytes.length < uncompressedSize / 2,
    `compression did something real (${bytes.length} vs ${uncompressedSize} bytes)`,
  );

  const original = normalize(exportBackup());

  // --- Restore into a completely separate, empty database ----------------
  const childScript = `
    import { readFileSync, writeFileSync } from 'node:fs';
    const { decodeBackupFile } = await import(${JSON.stringify(new URL('./backup-file.js', import.meta.url).href)});
    const { importBackup, exportBackup } = await import(${JSON.stringify(new URL('./config-backup.js', import.meta.url).href)});
    const { getAllConfigEntries } = await import(${JSON.stringify(new URL('./db.js', import.meta.url).href)});

    if (Object.keys(getAllConfigEntries()).length !== 0) throw new Error('the fresh database was not empty');

    const decoded = decodeBackupFile(readFileSync(${JSON.stringify(backupPath)}));
    const result = importBackup(decoded);
    if (!result.ok) throw new Error('import failed: ' + result.error);
    writeFileSync(${JSON.stringify(roundTripPath)}, JSON.stringify({ result, dump: exportBackup() }));
  `;

  execFileSync(process.execPath, ['--input-type=module', '-e', childScript], {
    env: { ...process.env, MLPR_DB_PATH: freshDbPath },
    stdio: ['ignore', 'ignore', 'inherit'],
  });

  // --- Compare ------------------------------------------------------------
  const { result, dump } = JSON.parse(readFileSync(roundTripPath, 'utf8'));

  assert.equal(result.ok, true);
  assert.deepEqual(result.counts, {
    dailyStats: 40,
    seenAircraft: ROWS,
    allSeenAircraft: ROWS,
    seenFlights: ROWS,
    registrations: ROWS,
  });

  const restored = normalize(dump);
  assert.deepEqual(restored.config, original.config, 'every config row came back byte-for-byte');
  assert.deepEqual(restored.tables, original.tables, 'every history row came back unchanged');

  // Spot-check the things that would be easy to lose silently in the middle
  // of a deepEqual over thousands of rows.
  assert.equal(JSON.parse(restored.config.antennaStats).cells[7][0][1], 'hex7');
  assert.equal(restored.tables.registrations[0].typeCode, null, 'a null type stays null, not ""');
  assert.equal(restored.tables.registrations[1].timesSeen, 2);
});
