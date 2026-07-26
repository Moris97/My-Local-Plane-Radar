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
});

function aircraftFixture(overrides = {}) {
  return { hex: `hex-${Math.random().toString(16).slice(2)}`, flight: 'TEST123', ...overrides };
}

test('squawk 7700 triggers a notification', () => {
  rules.evaluateAircraftRules(aircraftFixture({ squawk: '7700' }));
  assert.equal(sent.filter((n) => n.payload.title.startsWith('Squawk')).length, 1);
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

test('first-seen fires exactly once for a given hex', () => {
  const aircraft = aircraftFixture();
  rules.evaluateAircraftRules(aircraft);
  rules.evaluateAircraftRules(aircraft);
  assert.equal(sent.filter((n) => n.payload.title === 'First time seen').length, 1);
});

test('first-seen still records the hex as seen even when disabled', () => {
  updateNotificationSettings({ firstSeenEnabled: false });
  const aircraft = aircraftFixture();
  rules.evaluateAircraftRules(aircraft);
  assert.equal(sent.filter((n) => n.payload.title === 'First time seen').length, 0);

  updateNotificationSettings({ firstSeenEnabled: true });
  rules.evaluateAircraftRules(aircraft);
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
