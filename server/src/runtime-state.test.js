import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = mkdtempSync(join(tmpdir(), 'mlpr-runtime-state-test-'));
process.env.MLPR_DB_PATH = join(tmpDir, 'test.db');

const { flushAllRuntimeState, reloadRuntimeStateFromDb } = await import('./runtime-state.js');
const { importBackup } = await import('./config-backup.js');
const { getConfig, getAllAircraftSeenRaw, getAllRegistrations } = await import('./db.js');
const { noteAircraftSeen, getAircraftSeenCount } = await import('./aircraft-seen.js');
const { noteFlightSeen, getSeenFlightsCount } = await import('./seen-flights.js');
const { recordSighting, getRegistrationsList } = await import('./stats-registrations.js');
const { recordAntennaSample, getAntennaStatsRevision, getAltitudeBandStats } = await import('./antenna-stats.js');
const { evaluateRangeRecordRule, getAllTimeMaxRangeKm, setNotifySender } = await import('./notifications/rules.js');

before(() => {
  // These tests drive the real rule engine; nothing should try to reach
  // ntfy.sh from a test run.
  setNotifySender(() => {});
});

after(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// This whole file exists for one failure mode: several modules hold
// authoritative state in RAM and only write it out on a 45s/5min/1h timer,
// so a restore that doesn't invalidate them looks like it worked and then
// silently undoes itself at the next flush.

test('flushAllRuntimeState writes every in-memory cache out to SQLite', () => {
  noteAircraftSeen('f10001', 1000);
  noteFlightSeen('FLUSH01', 1000);
  recordSighting('SP-FLU1', { typeCode: 'B738', airlineIcao: 'LOT' }, 1000);
  recordAntennaSample({
    homeLat: 50, homeLon: 20, lat: 50.5, lon: 20.5, altBaro: 30000, hex: 'f10001', messages: 40,
  });
  evaluateRangeRecordRule(123.4, { hex: 'f10001' });

  // Nothing is on disk yet -- that is the entire premise.
  assert.equal(getAllAircraftSeenRaw().some((row) => row.hex === 'f10001'), false);
  assert.equal(getConfig('antennaStats'), null);

  flushAllRuntimeState();

  assert.equal(getAllAircraftSeenRaw().some((row) => row.hex === 'f10001'), true);
  assert.equal(getAllRegistrations().some((row) => row.registration === 'SP-FLU1'), true);
  assert.ok(getConfig('antennaStats'), 'the antenna blob must be flushed too, not just the 45s tick');
  assert.equal(getConfig('allTimeMaxRangeKm'), '123.4');
  assert.ok(getConfig('statsHistorySnapshot'), 'the hourly snapshot must be flushed too');
});

test('reloadRuntimeStateFromDb makes an imported row visible through the cache modules', () => {
  // Seed a live cache first, so the reload has something to actually drop.
  noteAircraftSeen('f20001', 2000);
  recordSighting('SP-LIV1', { typeCode: 'A320' }, 2000);
  flushAllRuntimeState();

  const liveAircraftCount = getAircraftSeenCount();
  const liveFlightCount = getSeenFlightsCount();

  // Simulate the restore: rows written straight to SQLite behind the caches'
  // backs, exactly as importBackup does.
  const result = importBackup({
    config: {},
    tables: {
      allSeenAircraft: [{ hex: 'imported1', firstSeenAt: 10, lastSeenAt: 20 }],
      seenFlights: [{ flight: 'IMPORTED1', firstSeenAt: 10, lastSeenAt: 20 }],
      registrations: [
        { registration: 'SP-IMP1', typeCode: 'B77W', airlineIcao: 'LOT', firstSeenAt: 10, lastSeenAt: 20, timesSeen: 9 },
      ],
    },
  });
  assert.equal(result.ok, true);

  reloadRuntimeStateFromDb();

  assert.equal(getAircraftSeenCount(), liveAircraftCount + 1, 'the imported hex must be visible through the cache');
  assert.equal(getSeenFlightsCount(), liveFlightCount + 1);
  const registrations = getRegistrationsList();
  assert.ok(registrations.some((row) => row.registration === 'SP-IMP1'), 'the imported registration is readable');
  // And the pre-import live data survived the merge rather than being wiped.
  assert.ok(registrations.some((row) => row.registration === 'SP-LIV1'), 'live rows survive a restore');
});

test('the all-time range record cache picks up an imported value instead of overwriting it', () => {
  // Beats whatever an earlier test in this file left behind, so the live
  // record is unambiguously this one before the restore lands.
  evaluateRangeRecordRule(200, { hex: 'f30001' });
  flushAllRuntimeState();
  assert.equal(getAllTimeMaxRangeKm(), 200);

  importBackup({ config: { allTimeMaxRangeKm: '412.5' } });
  reloadRuntimeStateFromDb();

  assert.equal(getAllTimeMaxRangeKm(), 412.5, 'the restored record must win over the cached one');

  // The real hazard this guards: with the cache still reading 200, the next
  // sample above 200 would be treated as a new record and would flush 201
  // back over the restored 412.5.
  evaluateRangeRecordRule(201, { hex: 'f30001' });
  flushAllRuntimeState();
  assert.equal(getConfig('allTimeMaxRangeKm'), '412.5', 'a smaller live sample must not beat the restored record');
});

test('the antenna reload keeps the stored blob and bumps the revision', () => {
  recordAntennaSample({
    homeLat: 50, homeLon: 20, lat: 51, lon: 21, altBaro: 10000, hex: 'f40001', messages: 40,
  });
  flushAllRuntimeState();
  const storedBlob = getConfig('antennaStats');
  const revisionBefore = getAntennaStatsRevision();

  reloadRuntimeStateFromDb();

  assert.equal(getConfig('antennaStats'), storedBlob, 'the reload must not delete the blob it is meant to re-read');
  assert.ok(
    getAntennaStatsRevision() > revisionBefore,
    'the revision must move forward, or a browser holding the old number never refetches its coverage',
  );
  // And the cells really do come back from disk rather than being empty.
  const bands = getAltitudeBandStats();
  assert.ok(bands.some((band) => band.maxRangeKm > 0), 'reloaded cells still hold the recorded sample');
});
