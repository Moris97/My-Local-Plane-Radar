import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = mkdtempSync(join(tmpdir(), 'mlpr-rules-test-'));
process.env.MLPR_DB_PATH = join(tmpDir, 'test.db');

const rules = await import('./rules.js');
const { resetCooldowns } = await import('./cooldown.js');
const { updateNotificationSettings } = await import('./settings.js');
const { addWatchEntry, getWatchList, removeWatchEntry } = await import('./watchlist.js');
const { hasSeenAircraft } = await import('../db.js');

after(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

let sent;
rules.setNotifySender((topic, payload) => {
  sent.push({ topic, payload });
  return Promise.resolve();
});

beforeEach(() => {
  sent = [];
  resetCooldowns();
  updateNotificationSettings({
    squawkEnabled: true,
    squawkCodes: { 7500: true, 7600: true, 7700: true },
    firstSeenEnabled: true,
    rangeRecordEnabled: true,
  });
  for (const entry of getWatchList()) {
    removeWatchEntry(entry.id);
  }
});

function aircraftFixture(overrides = {}) {
  return { hex: `hex-${Math.random().toString(16).slice(2)}`, flight: 'TEST123', ...overrides };
}

test('squawk 7700 triggers a notification', () => {
  rules.evaluateAircraftRules(aircraftFixture({ squawk: '7700' }));
  assert.equal(sent.filter((n) => n.payload.title.startsWith('Squawk')).length, 1);
});

test('notification message includes registration, type, flight, altitude and speed', () => {
  rules.evaluateAircraftRules(
    aircraftFixture({ squawk: '7700', registration: 'SP-TEST', typeCode: 'B738', altBaro: 5000, gs: 210.6 }),
  );
  const message = sent.find((n) => n.payload.title.startsWith('Squawk')).payload.message;
  assert.equal(message, 'TEST123 · SP-TEST · B738 · 5000 ft · 211 kt');
});

test('notification message shows "ground" for an on-ground aircraft and omits missing speed', () => {
  rules.evaluateAircraftRules(aircraftFixture({ squawk: '7700', onGround: true }));
  const message = sent.find((n) => n.payload.title.startsWith('Squawk')).payload.message;
  assert.equal(message, 'TEST123 · ground');
});

test('a non-emergency squawk does not trigger', () => {
  rules.evaluateAircraftRules(aircraftFixture({ squawk: '1200' }));
  assert.equal(sent.filter((n) => n.payload.title.startsWith('Squawk')).length, 0);
});

test('squawk rule respects the per-hex cooldown', () => {
  const aircraft = aircraftFixture({ squawk: '7700' });
  rules.evaluateAircraftRules(aircraft);
  rules.evaluateAircraftRules(aircraft);
  assert.equal(sent.filter((n) => n.payload.title.startsWith('Squawk')).length, 1);
});

test('squawkEnabled=false suppresses all squawk notifications', () => {
  updateNotificationSettings({ squawkEnabled: false });
  rules.evaluateAircraftRules(aircraftFixture({ squawk: '7700' }));
  assert.equal(sent.filter((n) => n.payload.title.startsWith('Squawk')).length, 0);
});

test('disabling a specific squawk code only suppresses that code', () => {
  updateNotificationSettings({ squawkCodes: { 7700: false } });
  rules.evaluateAircraftRules(aircraftFixture({ squawk: '7700' }));
  rules.evaluateAircraftRules(aircraftFixture({ squawk: '7500' }));
  const squawkNotifications = sent.filter((n) => n.payload.title.startsWith('Squawk'));
  assert.equal(squawkNotifications.length, 1);
  assert.match(squawkNotifications[0].payload.title, /7500/);
});

test('first-seen does not fire on the very first tick a hex is noticed', () => {
  const aircraft = aircraftFixture();
  rules.evaluateAircraftRules(aircraft, Date.now());
  assert.equal(sent.filter((n) => n.payload.title === 'First time seen').length, 0);
});

test('first-seen still does not fire while still within the delay window', () => {
  const aircraft = aircraftFixture();
  const start = Date.now();
  rules.evaluateAircraftRules(aircraft, start);
  rules.evaluateAircraftRules(aircraft, start + 1000);
  assert.equal(sent.filter((n) => n.payload.title === 'First time seen').length, 0);
});

test('first-seen fires once the delay has elapsed, exactly once even with further ticks after', () => {
  const aircraft = aircraftFixture();
  const start = Date.now();
  rules.evaluateAircraftRules(aircraft, start);
  rules.evaluateAircraftRules(aircraft, start + 3000);
  rules.evaluateAircraftRules(aircraft, start + 4000);
  assert.equal(sent.filter((n) => n.payload.title === 'First time seen').length, 1);
});

test('a hex never seen again within the delay never fires and is never recorded as seen', () => {
  const aircraft = aircraftFixture();
  rules.evaluateAircraftRules(aircraft, Date.now());
  assert.equal(hasSeenAircraft(aircraft.hex), false);

  // No second tick for this hex, ever -- prunePendingFirstSeen(0) simulates
  // however much later "never" ends up meaning, evicting the still-pending
  // entry; a further tick (as if the hex reappeared much later) is treated
  // as a fresh first sighting rather than resuming the old one, and still
  // doesn't fire immediately.
  rules.prunePendingFirstSeen(0);
  rules.evaluateAircraftRules(aircraft, Date.now());
  assert.equal(sent.filter((n) => n.payload.title === 'First time seen').length, 0);
  assert.equal(hasSeenAircraft(aircraft.hex), false);
});

test('first-seen still records the hex as seen (once the delay elapses) even when disabled', () => {
  updateNotificationSettings({ firstSeenEnabled: false });
  const aircraft = aircraftFixture();
  const start = Date.now();
  rules.evaluateAircraftRules(aircraft, start);
  rules.evaluateAircraftRules(aircraft, start + 3000);
  assert.equal(sent.filter((n) => n.payload.title === 'First time seen').length, 0);

  updateNotificationSettings({ firstSeenEnabled: true });
  rules.evaluateAircraftRules(aircraft, start + 4000);
  assert.equal(sent.filter((n) => n.payload.title === 'First time seen').length, 0);
});

test('a higher range value triggers a record notification, a lower one does not', () => {
  rules.evaluateRangeRecordRule(100);
  assert.equal(sent.filter((n) => n.payload.title === 'New range record').length, 1);

  rules.evaluateRangeRecordRule(50);
  assert.equal(sent.filter((n) => n.payload.title === 'New range record').length, 1);

  rules.evaluateRangeRecordRule(150);
  assert.equal(sent.filter((n) => n.payload.title === 'New range record').length, 2);
});

test('rangeRecordEnabled=false still updates the record but sends nothing', () => {
  updateNotificationSettings({ rangeRecordEnabled: false });
  rules.evaluateRangeRecordRule(200);
  assert.equal(sent.filter((n) => n.payload.title === 'New range record').length, 0);

  updateNotificationSettings({ rangeRecordEnabled: true });
  rules.evaluateRangeRecordRule(150);
  assert.equal(sent.filter((n) => n.payload.title === 'New range record').length, 0);
});

test('getAllTimeMaxRangeKm reflects the record maintained by evaluateRangeRecordRule, regardless of notification toggle', () => {
  assert.equal(rules.getAllTimeMaxRangeKm(), 200);
});

function watchedNotifications() {
  return sent.filter((n) => n.payload.title === 'Watched aircraft');
}

test('watch-list matches by type, case-insensitively', () => {
  addWatchEntry({ matchType: 'type', matchValue: 'b738' });
  rules.evaluateAircraftRules(aircraftFixture({ typeCode: 'B738' }));
  assert.equal(watchedNotifications().length, 1);
});

test('watch-list matches by registration', () => {
  addWatchEntry({ matchType: 'registration', matchValue: 'SP-TEST' });
  rules.evaluateAircraftRules(aircraftFixture({ registration: 'sp-test' }));
  assert.equal(watchedNotifications().length, 1);
});

test('watch-list matches by flight number', () => {
  addWatchEntry({ matchType: 'flight', matchValue: 'WZZ66' });
  rules.evaluateAircraftRules(aircraftFixture({ flight: 'WZZ66' }));
  assert.equal(watchedNotifications().length, 1);
});

test('watch-list does not match an unrelated aircraft', () => {
  addWatchEntry({ matchType: 'type', matchValue: 'B738' });
  rules.evaluateAircraftRules(aircraftFixture({ typeCode: 'A320' }));
  assert.equal(watchedNotifications().length, 0);
});

test('altitude condition "below" only matches when actually below', () => {
  addWatchEntry({ matchType: 'type', matchValue: 'B738', altitudeOperator: 'below', altitudeValue: 5000 });
  rules.evaluateAircraftRules(aircraftFixture({ hex: 'cruise', typeCode: 'B738', altBaro: 35000 }));
  assert.equal(watchedNotifications().length, 0);

  rules.evaluateAircraftRules(aircraftFixture({ hex: 'descending', typeCode: 'B738', altBaro: 2000 }));
  assert.equal(watchedNotifications().length, 1);
});

test('altitude condition "above" only matches when actually above', () => {
  addWatchEntry({ matchType: 'type', matchValue: 'B738', altitudeOperator: 'above', altitudeValue: 10000 });
  rules.evaluateAircraftRules(aircraftFixture({ hex: 'low', typeCode: 'B738', altBaro: 2000 }));
  assert.equal(watchedNotifications().length, 0);

  rules.evaluateAircraftRules(aircraftFixture({ hex: 'high', typeCode: 'B738', altBaro: 35000 }));
  assert.equal(watchedNotifications().length, 1);
});

test('an on-ground aircraft counts as altitude 0 for the "below" condition', () => {
  addWatchEntry({ matchType: 'type', matchValue: 'B738', altitudeOperator: 'below', altitudeValue: 5000 });
  rules.evaluateAircraftRules(aircraftFixture({ typeCode: 'B738', onGround: true }));
  assert.equal(watchedNotifications().length, 1);
});

test('altitude condition does not match when altitude data is unavailable', () => {
  addWatchEntry({ matchType: 'type', matchValue: 'B738', altitudeOperator: 'below', altitudeValue: 5000 });
  rules.evaluateAircraftRules(aircraftFixture({ typeCode: 'B738' }));
  assert.equal(watchedNotifications().length, 0);
});

test('watch-list respects the per-hex cooldown', () => {
  addWatchEntry({ matchType: 'type', matchValue: 'B738' });
  const aircraft = aircraftFixture({ typeCode: 'B738' });
  rules.evaluateAircraftRules(aircraft);
  rules.evaluateAircraftRules(aircraft);
  assert.equal(watchedNotifications().length, 1);
});
