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
const { setConfigJSON, getConfig, setConfig } = await import('../db.js');
const { hasSeenAircraft } = await import('../aircraft-tracked.js');
const { setManualHome, clearManualHome } = await import('../home.js');
const smartHome = await import('./smart-home.js');

after(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// Fake MQTT client so the smart-home scope-boundary tests below don't open
// real sockets -- same shape as smart-home.test.js's own fake.
class FakeMqttClient {
  constructor() {
    this.published = [];
  }
  connect({ onConnect }) {
    onConnect?.();
  }
  publish(topic, rawPayload) {
    // Status-topic publishes ("online"/"offline") are plain strings, not
    // JSON -- only event payloads are, so parse best-effort.
    let payload;
    try {
      payload = JSON.parse(rawPayload);
    } catch {
      payload = rawPayload;
    }
    this.published.push({ topic, payload });
    return true;
  }
  disconnect() {}
}
let fakeSmartHomeClient;
smartHome.setMqttClientFactory(() => {
  fakeSmartHomeClient = new FakeMqttClient();
  return fakeSmartHomeClient;
});

let sent;
rules.setNotifySender((topic, payload) => {
  sent.push({ topic, payload });
  return Promise.resolve();
});

let uiEvents;
rules.setUiEventSender((event) => {
  uiEvents.push(event);
});

beforeEach(async () => {
  sent = [];
  uiEvents = [];
  resetCooldowns();
  rules.resetReceiverSilenceState();
  updateNotificationSettings({
    squawkEnabled: true,
    squawkCodes: { 7500: true, 7600: true, 7700: true },
    firstSeenEnabled: true,
    rangeRecordEnabled: true,
    watchedEnabled: true,
    receiverSilenceEnabled: true,
    overheadEnabled: false,
    overheadRadiusKm: 2,
  });
  clearManualHome();
  const { updateSmartHomeSettings } = await import('./settings.js');
  smartHome.shutdownSmartHome(); // force a fresh client each test, regardless of whether settings actually changed
  updateSmartHomeSettings({ enabled: true, brokerUrl: 'mqtt://test-broker:1883', topicPrefix: 'mlpr' });
  smartHome.reconfigureSmartHome();
  fakeSmartHomeClient.published.length = 0; // clear the retained "online" status publish
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

test('the record is NOT written to SQLite until flushAllTimeMaxRangeKmIfDirty runs, even though getAllTimeMaxRangeKm already reflects it', () => {
  // Deferred by design (moved off the per-second poll loop to avoid an SD
  // write on every improved record) -- getAllTimeMaxRangeKm reads the
  // in-memory cache, not SQLite, so it must already show 200 here.
  assert.equal(rules.getAllTimeMaxRangeKm(), 200);
  assert.notEqual(getConfig('allTimeMaxRangeKm'), '200');
});

test('flushAllTimeMaxRangeKmIfDirty persists the current record, then is a no-op until the record changes again', () => {
  rules.flushAllTimeMaxRangeKmIfDirty();
  assert.equal(getConfig('allTimeMaxRangeKm'), '200');

  // Change the stored value out from under the cache to prove a second
  // flush with nothing new really is a no-op -- a dirty flush would
  // overwrite this back to 200.
  setConfig('allTimeMaxRangeKm', '999');
  rules.flushAllTimeMaxRangeKmIfDirty();
  assert.equal(getConfig('allTimeMaxRangeKm'), '999');

  // A genuinely new record dirties it again and the next flush persists it.
  rules.evaluateRangeRecordRule(250);
  rules.flushAllTimeMaxRangeKmIfDirty();
  assert.equal(getConfig('allTimeMaxRangeKm'), '250');
});

test('resetAllTimeMaxRangeKm clears both SQLite and the in-memory cache', () => {
  rules.evaluateRangeRecordRule(300);
  assert.equal(rules.getAllTimeMaxRangeKm(), 300);

  rules.resetAllTimeMaxRangeKm();
  assert.equal(rules.getAllTimeMaxRangeKm(), 0);
  assert.equal(getConfig('allTimeMaxRangeKm'), null);

  // A record set right after a reset must be treated as a fresh record
  // (beating 0), not compared against the pre-reset value.
  rules.evaluateRangeRecordRule(10);
  assert.equal(rules.getAllTimeMaxRangeKm(), 10);
});

function silentNotifications() {
  return sent.filter((n) => n.payload.title === 'Receiver silent');
}

const ONE_HOUR_MS = 60 * 60 * 1000;

test('no notification before the silence threshold elapses', () => {
  const start = Date.now();
  rules.resetReceiverSilenceState(start);
  rules.evaluateReceiverSilenceRule(false, start + ONE_HOUR_MS - 1);
  assert.equal(silentNotifications().length, 0);
});

test('fires once the receiver has been silent for over an hour, and only once', () => {
  const start = Date.now();
  rules.resetReceiverSilenceState(start);
  rules.evaluateReceiverSilenceRule(false, start + ONE_HOUR_MS + 1);
  assert.equal(silentNotifications().length, 1);

  // Still silent an hour later -- must not fire again mid-outage.
  rules.evaluateReceiverSilenceRule(false, start + 2 * ONE_HOUR_MS);
  assert.equal(silentNotifications().length, 1);
});

test('any activity resets the timer, so a brief gap does not trigger it', () => {
  const start = Date.now();
  rules.resetReceiverSilenceState(start);
  // A contact 59 minutes in resets the clock -- the next hour is measured
  // from there, not from `start`.
  rules.evaluateReceiverSilenceRule(true, start + ONE_HOUR_MS - 60_000);
  rules.evaluateReceiverSilenceRule(false, start + ONE_HOUR_MS + 1);
  assert.equal(silentNotifications().length, 0);
});

test('a silence period can notify again after activity resumes and then stops once more', () => {
  const start = Date.now();
  rules.resetReceiverSilenceState(start);
  rules.evaluateReceiverSilenceRule(false, start + ONE_HOUR_MS + 1);
  assert.equal(silentNotifications().length, 1);

  rules.evaluateReceiverSilenceRule(true, start + ONE_HOUR_MS + 2);
  rules.evaluateReceiverSilenceRule(false, start + 2 * ONE_HOUR_MS + 3);
  assert.equal(silentNotifications().length, 2);
});

test('receiverSilenceEnabled=false suppresses the notification but still latches, so re-enabling mid-outage does not immediately fire', () => {
  const start = Date.now();
  rules.resetReceiverSilenceState(start);
  updateNotificationSettings({ receiverSilenceEnabled: false });
  rules.evaluateReceiverSilenceRule(false, start + ONE_HOUR_MS + 1);
  assert.equal(silentNotifications().length, 0);

  updateNotificationSettings({ receiverSilenceEnabled: true });
  rules.evaluateReceiverSilenceRule(false, start + ONE_HOUR_MS + 2);
  assert.equal(silentNotifications().length, 0);

  // The next outage, after activity resumes in between, does notify.
  rules.evaluateReceiverSilenceRule(true, start + ONE_HOUR_MS + 3);
  rules.evaluateReceiverSilenceRule(false, start + 2 * ONE_HOUR_MS + 4);
  assert.equal(silentNotifications().length, 1);
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

test('watchedEnabled=false suppresses watch-list notifications entirely', () => {
  updateNotificationSettings({ watchedEnabled: false });
  addWatchEntry({ matchType: 'type', matchValue: 'B738' });
  rules.evaluateAircraftRules(aircraftFixture({ typeCode: 'B738' }));
  assert.equal(watchedNotifications().length, 0);
  assert.equal(fakeSmartHomeClient.published.length, 0);
});

// Trigger area (watchlist.js's `area`). Placeholder coordinates only --
// never the real receiver location (see CLAUDE.md's home-location rule).
// The centre is deliberately an arbitrary point, not home: the feature
// exists to watch a specific piece of sky (an airfield, an approach path)
// that may be well away from the antenna.
const AREA_CENTRE = { lat: 50.0, lon: 20.0 };

test('circle area matches an aircraft inside the radius', () => {
  addWatchEntry({
    matchType: 'type',
    matchValue: 'B738',
    area: { kind: 'circle', ...AREA_CENTRE, radiusKm: 20 },
  });
  // ~11 km north of the centre (0.1 deg latitude is ~11.1 km).
  rules.evaluateAircraftRules(aircraftFixture({ typeCode: 'B738', lat: 50.1, lon: 20.0 }));
  assert.equal(watchedNotifications().length, 1);
});

test('circle area does not match an aircraft outside the radius', () => {
  addWatchEntry({
    matchType: 'type',
    matchValue: 'B738',
    area: { kind: 'circle', ...AREA_CENTRE, radiusKm: 20 },
  });
  // ~55 km north of the centre, well outside a 20 km radius.
  rules.evaluateAircraftRules(aircraftFixture({ typeCode: 'B738', lat: 50.5, lon: 20.0 }));
  assert.equal(watchedNotifications().length, 0);
});

test('an area-restricted entry never matches an aircraft with no position', () => {
  addWatchEntry({
    matchType: 'type',
    matchValue: 'B738',
    area: { kind: 'circle', ...AREA_CENTRE, radiusKm: 20 },
  });
  // A Mode-S-only contact -- missing data must never produce a false
  // positive, same rule the altitude condition already follows.
  rules.evaluateAircraftRules(aircraftFixture({ typeCode: 'B738' }));
  assert.equal(watchedNotifications().length, 0);
});

test('an entry with no area still matches regardless of position', () => {
  addWatchEntry({ matchType: 'type', matchValue: 'B738' });
  rules.evaluateAircraftRules(aircraftFixture({ typeCode: 'B738', lat: 12.3, lon: 45.6 }));
  assert.equal(watchedNotifications().length, 1);
});

test('area and altitude conditions must BOTH hold, not either', () => {
  addWatchEntry({
    matchType: 'type',
    matchValue: 'B738',
    altitudeOperator: 'below',
    altitudeValue: 5000,
    area: { kind: 'circle', ...AREA_CENTRE, radiusKm: 20 },
  });

  // Inside the area but too high.
  rules.evaluateAircraftRules(aircraftFixture({ hex: 'high-inside', typeCode: 'B738', lat: 50.1, lon: 20.0, altBaro: 35000 }));
  assert.equal(watchedNotifications().length, 0);

  // Low enough but outside the area.
  rules.evaluateAircraftRules(aircraftFixture({ hex: 'low-outside', typeCode: 'B738', lat: 50.5, lon: 20.0, altBaro: 2000 }));
  assert.equal(watchedNotifications().length, 0);

  // Both conditions satisfied.
  rules.evaluateAircraftRules(aircraftFixture({ hex: 'low-inside', typeCode: 'B738', lat: 50.1, lon: 20.0, altBaro: 2000 }));
  assert.equal(watchedNotifications().length, 1);
});

test('rectangle area matches an aircraft inside the box', () => {
  addWatchEntry({
    matchType: 'type',
    matchValue: 'B738',
    area: { kind: 'rectangle', ...AREA_CENTRE, widthKm: 40, heightKm: 40 },
  });
  // ~11 km north of centre, comfortably inside a 40x40 km box.
  rules.evaluateAircraftRules(aircraftFixture({ typeCode: 'B738', lat: 50.1, lon: 20.0 }));
  assert.equal(watchedNotifications().length, 1);
});

test('rectangle area rejects an aircraft outside on either axis', () => {
  addWatchEntry({
    matchType: 'type',
    matchValue: 'B738',
    area: { kind: 'rectangle', ...AREA_CENTRE, widthKm: 40, heightKm: 40 },
  });

  // Too far north (~55 km) but bang on the centre longitude.
  rules.evaluateAircraftRules(aircraftFixture({ hex: 'north', typeCode: 'B738', lat: 50.5, lon: 20.0 }));
  assert.equal(watchedNotifications().length, 0);

  // On the centre latitude but far to the east (~1 deg lon is ~71 km here).
  rules.evaluateAircraftRules(aircraftFixture({ hex: 'east', typeCode: 'B738', lat: 50.0, lon: 21.0 }));
  assert.equal(watchedNotifications().length, 0);
});

test('a rectangle is not a circle: the corners are inside, unlike an equivalent circle', () => {
  // A point diagonally out towards a corner is ~1.41x further than the
  // half-width, so it would fall outside a circle of that radius but must
  // be inside the box -- this is what proves the two shapes really differ
  // rather than the rectangle quietly reusing the circle's test.
  addWatchEntry({
    matchType: 'type',
    matchValue: 'B738',
    area: { kind: 'rectangle', ...AREA_CENTRE, widthKm: 60, heightKm: 60 },
  });
  // ~25 km north and ~25 km east of centre -- ~35 km diagonally.
  rules.evaluateAircraftRules(aircraftFixture({ typeCode: 'B738', lat: 50.225, lon: 20.35 }));
  assert.equal(watchedNotifications().length, 1);
});

// A 1-degree square, so "inside"/"outside" are obvious by inspection.
const SQUARE_POINTS = [
  { lat: 50.0, lon: 20.0 },
  { lat: 51.0, lon: 20.0 },
  { lat: 51.0, lon: 21.0 },
  { lat: 50.0, lon: 21.0 },
];

test('polygon area matches an aircraft inside the shape', () => {
  addWatchEntry({
    matchType: 'type',
    matchValue: 'B738',
    area: { kind: 'polygon', lat: 50.5, lon: 20.5, points: SQUARE_POINTS },
  });
  rules.evaluateAircraftRules(aircraftFixture({ typeCode: 'B738', lat: 50.5, lon: 20.5 }));
  assert.equal(watchedNotifications().length, 1);
});

test('polygon area rejects an aircraft outside the shape', () => {
  addWatchEntry({
    matchType: 'type',
    matchValue: 'B738',
    area: { kind: 'polygon', lat: 50.5, lon: 20.5, points: SQUARE_POINTS },
  });
  rules.evaluateAircraftRules(aircraftFixture({ hex: 'west', typeCode: 'B738', lat: 50.5, lon: 19.5 }));
  rules.evaluateAircraftRules(aircraftFixture({ hex: 'north', typeCode: 'B738', lat: 51.5, lon: 20.5 }));
  assert.equal(watchedNotifications().length, 0);
});

test('a concave polygon really is concave: the notch is outside', () => {
  // An L/chevron shape. A point in the notch sits inside the shape's
  // bounding box but outside the shape itself -- which is the whole reason
  // free-form areas exist, and what a bounds check would get wrong.
  const chevron = [
    { lat: 50.0, lon: 20.0 },
    { lat: 51.0, lon: 20.0 },
    { lat: 51.0, lon: 21.0 },
    { lat: 50.6, lon: 21.0 },
    { lat: 50.6, lon: 20.4 },
    { lat: 50.0, lon: 20.4 },
  ];
  addWatchEntry({ matchType: 'type', matchValue: 'B738', area: { kind: 'polygon', lat: 50.5, lon: 20.5, points: chevron } });

  // In the notch: inside the bounding box, outside the shape.
  rules.evaluateAircraftRules(aircraftFixture({ hex: 'notch', typeCode: 'B738', lat: 50.2, lon: 20.8 }));
  assert.equal(watchedNotifications().length, 0);

  // In the solid arm of the shape.
  rules.evaluateAircraftRules(aircraftFixture({ hex: 'arm', typeCode: 'B738', lat: 50.2, lon: 20.2 }));
  assert.equal(watchedNotifications().length, 1);
});

test('an area-restricted polygon entry still never matches a position-less aircraft', () => {
  addWatchEntry({
    matchType: 'type',
    matchValue: 'B738',
    area: { kind: 'polygon', lat: 50.5, lon: 20.5, points: SQUARE_POINTS },
  });
  rules.evaluateAircraftRules(aircraftFixture({ typeCode: 'B738' }));
  assert.equal(watchedNotifications().length, 0);
});

test('an unrecognised area kind matches nothing rather than everything', () => {
  // Deliberately bypasses addWatchEntry (validateArea would reject this
  // shape) -- simulates an entry written by a future version with a shape
  // this build doesn't know about, then read back after a downgrade.
  const entry = addWatchEntry({ matchType: 'type', matchValue: 'B738' });
  const stored = getWatchList();
  stored.find((e) => e.id === entry.id).area = { kind: 'hexagon', lat: 50.0, lon: 20.0, radiusKm: 20 };
  setConfigJSON('watchList', stored);

  rules.evaluateAircraftRules(aircraftFixture({ typeCode: 'B738', lat: 50.0, lon: 20.0 }));
  assert.equal(watchedNotifications().length, 0);
});

// Smart-home (MQTT) scope boundary: wired to first-seen, watch-list, and
// squawk; deliberately NOT range-record (explicit product decision, not an
// oversight -- see rules.js's evaluateAircraftRules).
test('first-seen publishes a smart-home event alongside the ntfy notification', () => {
  const aircraft = aircraftFixture();
  const start = Date.now();
  rules.evaluateAircraftRules(aircraft, start);
  rules.evaluateAircraftRules(aircraft, start + 3000);

  const events = fakeSmartHomeClient.published.filter((p) => p.topic === 'mlpr/events/first_seen');
  assert.equal(events.length, 1);
  assert.equal(events[0].payload.reason, 'first_seen');
  assert.equal(events[0].payload.hex, aircraft.hex);
});

test('watch-list match publishes a smart-home event with the matched type/value', () => {
  addWatchEntry({ matchType: 'type', matchValue: 'B738' });
  rules.evaluateAircraftRules(aircraftFixture({ typeCode: 'B738' }));

  const events = fakeSmartHomeClient.published.filter((p) => p.topic === 'mlpr/events/watchlist');
  assert.equal(events.length, 1);
  assert.equal(events[0].payload.matchedType, 'type');
  assert.equal(events[0].payload.matchedValue, 'B738');
});

test('squawk emergency publishes a smart-home event with the squawk code/meaning', () => {
  rules.evaluateAircraftRules(aircraftFixture({ squawk: '7700' }));

  const events = fakeSmartHomeClient.published.filter((p) => p.topic === 'mlpr/events/squawk');
  assert.equal(events.length, 1);
  assert.equal(events[0].payload.squawk, '7700');
  assert.equal(events[0].payload.squawkMeaning, 'Emergency');
});

test('squawkEnabled=false suppresses the smart-home event too, not just ntfy', () => {
  updateNotificationSettings({ squawkEnabled: false });
  rules.evaluateAircraftRules(aircraftFixture({ squawk: '7700' }));
  assert.equal(fakeSmartHomeClient.published.length, 0);
});

test('a range record does NOT publish a smart-home event (deliberately out of scope)', () => {
  rules.evaluateRangeRecordRule(9999);
  assert.equal(fakeSmartHomeClient.published.length, 0);
});

// Overhead-proximity alert. Placeholder coordinates only, same rule as
// AREA_CENTRE above. 0.01 deg of latitude is ~1.11 km -- fine-grained
// enough for the small (default 2 km) radius this rule actually uses.
const HOME = { lat: 50.0, lon: 20.0 };

function overheadNotifications() {
  return sent.filter((n) => n.payload.title === 'Nearby aircraft');
}

test('disabled by default: no notification even directly over home', () => {
  setManualHome(HOME.lat, HOME.lon);
  // overheadEnabled: false is what beforeEach already sets -- this is
  // exercising that default, not overriding it.
  rules.evaluateAircraftRules(aircraftFixture({ lat: HOME.lat, lon: HOME.lon }));
  assert.equal(overheadNotifications().length, 0);
});

test('enabled but no home location configured: never fires, however close', () => {
  updateNotificationSettings({ overheadEnabled: true });
  // No setManualHome() call -- getEffectiveHome() returns null in this test
  // environment (no receiver.json auto-detection either).
  rules.evaluateAircraftRules(aircraftFixture({ lat: HOME.lat, lon: HOME.lon }));
  assert.equal(overheadNotifications().length, 0);
});

test('an aircraft with no position never matches, regardless of settings', () => {
  updateNotificationSettings({ overheadEnabled: true });
  setManualHome(HOME.lat, HOME.lon);
  rules.evaluateAircraftRules(aircraftFixture());
  assert.equal(overheadNotifications().length, 0);
});

test('fires for an aircraft inside the configured radius', () => {
  updateNotificationSettings({ overheadEnabled: true, overheadRadiusKm: 2 });
  setManualHome(HOME.lat, HOME.lon);
  // ~1.1 km north of home, inside a 2 km radius.
  rules.evaluateAircraftRules(aircraftFixture({ lat: 50.01, lon: 20.0 }));
  assert.equal(overheadNotifications().length, 1);
});

test('does not fire for an aircraft outside the configured radius', () => {
  updateNotificationSettings({ overheadEnabled: true, overheadRadiusKm: 2 });
  setManualHome(HOME.lat, HOME.lon);
  // ~5.5 km north of home, outside a 2 km radius.
  rules.evaluateAircraftRules(aircraftFixture({ lat: 50.05, lon: 20.0 }));
  assert.equal(overheadNotifications().length, 0);
});

test('a wider radius catches an aircraft a narrower one would miss', () => {
  updateNotificationSettings({ overheadEnabled: true, overheadRadiusKm: 10 });
  setManualHome(HOME.lat, HOME.lon);
  rules.evaluateAircraftRules(aircraftFixture({ lat: 50.05, lon: 20.0 }));
  assert.equal(overheadNotifications().length, 1);
});

test('respects the per-hex cooldown', () => {
  updateNotificationSettings({ overheadEnabled: true });
  setManualHome(HOME.lat, HOME.lon);
  const aircraft = aircraftFixture({ lat: 50.01, lon: 20.0 });
  rules.evaluateAircraftRules(aircraft);
  rules.evaluateAircraftRules(aircraft);
  assert.equal(overheadNotifications().length, 1);
});

test('message reports azimuth and omits ETA/elevation when track/speed/altitude are unavailable', () => {
  updateNotificationSettings({ overheadEnabled: true });
  setManualHome(HOME.lat, HOME.lon);
  // Due north of home -- a clean, unambiguous azimuth to assert on.
  rules.evaluateAircraftRules(aircraftFixture({ lat: 50.01, lon: 20.0 }));
  const message = overheadNotifications()[0].payload.message;
  assert.ok(message.includes('0° az'), message);
  assert.ok(!message.includes('elev'), message);
  assert.ok(!message.includes('closest in'), message);
});

test('message includes an ETA when the aircraft is heading toward home', () => {
  updateNotificationSettings({ overheadEnabled: true });
  setManualHome(HOME.lat, HOME.lon);
  // Due north of home, heading due south (180) -- straight toward it.
  rules.evaluateAircraftRules(aircraftFixture({ lat: 50.01, lon: 20.0, track: 180, gs: 100 }));
  const message = overheadNotifications()[0].payload.message;
  assert.ok(/closest in \d+s/.test(message), message);
});

test('message includes elevation when altitude is available', () => {
  updateNotificationSettings({ overheadEnabled: true });
  setManualHome(HOME.lat, HOME.lon);
  rules.evaluateAircraftRules(aircraftFixture({ lat: 50.01, lon: 20.0, altBaro: 3000 }));
  const message = overheadNotifications()[0].payload.message;
  assert.ok(/\d+° elev/.test(message), message);
});

test('an aircraft heading away from home gets an azimuth but no ETA', () => {
  updateNotificationSettings({ overheadEnabled: true });
  setManualHome(HOME.lat, HOME.lon);
  // Due north of home, continuing further north (track 0) -- receding.
  rules.evaluateAircraftRules(aircraftFixture({ lat: 50.01, lon: 20.0, track: 0, gs: 100 }));
  const message = overheadNotifications()[0].payload.message;
  assert.ok(message.includes('0° az'), message);
  assert.ok(!message.includes('closest in'), message);
});

test('publishes a smart-home event with the computed geometry', () => {
  updateNotificationSettings({ overheadEnabled: true });
  setManualHome(HOME.lat, HOME.lon);
  rules.evaluateAircraftRules(aircraftFixture({ lat: 50.01, lon: 20.0, track: 180, gs: 100, altBaro: 3000 }));

  const events = fakeSmartHomeClient.published.filter((p) => p.topic === 'mlpr/events/overhead');
  assert.equal(events.length, 1);
  const { payload } = events[0];
  assert.equal(payload.azimuthDeg, 0);
  assert.equal(typeof payload.elevationDeg, 'number');
  assert.equal(typeof payload.etaSeconds, 'number');
  assert.equal(typeof payload.distanceKm, 'number');
});

test('overheadEnabled=false suppresses the smart-home event too, not just ntfy', () => {
  setManualHome(HOME.lat, HOME.lon);
  rules.evaluateAircraftRules(aircraftFixture({ lat: 50.01, lon: 20.0 }));
  assert.equal(fakeSmartHomeClient.published.length, 0);
});

// On-map toast/glow feature (v2.1.20). Two independent things to verify:
// alertKinds (evaluateAircraftRules' return value, a live cooldown-
// independent condition) and the UI events themselves (cooldown-gated,
// same as the ntfy sends they sit next to).

test('evaluateAircraftRules returns squawk in alertKinds regardless of cooldown', () => {
  const aircraft = aircraftFixture({ squawk: '7700' });
  const first = rules.evaluateAircraftRules(aircraft);
  const second = rules.evaluateAircraftRules(aircraft); // on cooldown now
  assert.deepEqual(first, ['squawk']);
  assert.deepEqual(second, ['squawk']);
});

test('alertKinds is empty when the squawk condition is false', () => {
  assert.deepEqual(rules.evaluateAircraftRules(aircraftFixture({ squawk: '1200' })), []);
});

test('alertKinds includes watched even while the notification itself is on cooldown', () => {
  addWatchEntry({ matchType: 'type', matchValue: 'B738' });
  const aircraft = aircraftFixture({ typeCode: 'B738' });
  const first = rules.evaluateAircraftRules(aircraft);
  const second = rules.evaluateAircraftRules(aircraft);
  assert.deepEqual(first, ['watched']);
  assert.deepEqual(second, ['watched']);
  // The underlying restructuring point: only one notification fired even
  // though the match was evaluated (and reported via alertKinds) both times.
  assert.equal(watchedNotifications().length, 1);
});

test('watchedEnabled=false means never in alertKinds, even for a matching aircraft', () => {
  updateNotificationSettings({ watchedEnabled: false });
  addWatchEntry({ matchType: 'type', matchValue: 'B738' });
  assert.deepEqual(rules.evaluateAircraftRules(aircraftFixture({ typeCode: 'B738' })), []);
});

test('alertKinds can report both squawk and watched at once', () => {
  addWatchEntry({ matchType: 'type', matchValue: 'B738' });
  const kinds = rules.evaluateAircraftRules(aircraftFixture({ typeCode: 'B738', squawk: '7700' }));
  assert.deepEqual([...kinds].sort(), ['squawk', 'watched']);
});

test('squawk emits a UI event alongside the ntfy notification, not on the next (cooled-down) tick', () => {
  const aircraft = aircraftFixture({ squawk: '7700', registration: 'SP-TEST' });
  rules.evaluateAircraftRules(aircraft);
  rules.evaluateAircraftRules(aircraft);
  const events = uiEvents.filter((e) => e.kind === 'squawk');
  assert.equal(events.length, 1);
  assert.equal(events[0].hex, aircraft.hex);
  assert.equal(events[0].aircraft.registration, 'SP-TEST');
  assert.equal(events[0].squawk, '7700');
  assert.equal(events[0].squawkMeaning, 'Emergency');
});

test('squawkEnabled=false suppresses the UI event too', () => {
  updateNotificationSettings({ squawkEnabled: false });
  rules.evaluateAircraftRules(aircraftFixture({ squawk: '7700' }));
  assert.equal(uiEvents.filter((e) => e.kind === 'squawk').length, 0);
});

test('first-seen emits a UI event once the delay elapses', () => {
  const aircraft = aircraftFixture();
  const start = Date.now();
  rules.evaluateAircraftRules(aircraft, start);
  rules.evaluateAircraftRules(aircraft, start + 3000);
  const events = uiEvents.filter((e) => e.kind === 'first_seen');
  assert.equal(events.length, 1);
  assert.equal(events[0].hex, aircraft.hex);
});

test('watchlist emits a UI event only when the notification actually fires, not every tick it matches', () => {
  addWatchEntry({ matchType: 'type', matchValue: 'B738' });
  const aircraft = aircraftFixture({ typeCode: 'B738' });
  rules.evaluateAircraftRules(aircraft);
  rules.evaluateAircraftRules(aircraft); // on cooldown -- still in alertKinds, but no new event
  const events = uiEvents.filter((e) => e.kind === 'watchlist');
  assert.equal(events.length, 1);
  assert.equal(events[0].matchedType, 'type');
  assert.equal(events[0].matchedValue, 'B738');
});

test('a range record with a known aircraft emits a UI event carrying it', () => {
  // The in-memory record cache is module-level and not reset between tests
  // in this file (see the 'resetAllTimeMaxRangeKm' test above for the
  // mechanism) -- earlier tests have already pushed it well past any small
  // number, so this resets to a known baseline first.
  rules.resetAllTimeMaxRangeKm();
  const aircraft = aircraftFixture({ hex: 'rangeholder', registration: 'SP-FAR' });
  rules.evaluateRangeRecordRule(500, aircraft);
  const events = uiEvents.filter((e) => e.kind === 'range_record');
  assert.equal(events.length, 1);
  assert.equal(events[0].hex, 'rangeholder');
  assert.equal(events[0].aircraft.registration, 'SP-FAR');
  assert.equal(events[0].rangeKm, 500);
});

test('a range record with no known aircraft (legacy call shape) still notifies but emits no UI event', () => {
  rules.resetAllTimeMaxRangeKm();
  rules.evaluateRangeRecordRule(500);
  assert.equal(sent.some((n) => n.payload.title === 'New range record'), true);
  assert.equal(uiEvents.filter((e) => e.kind === 'range_record').length, 0);
});

test('receiver silence emits a UI event with no hex/aircraft', () => {
  const start = Date.now();
  rules.evaluateReceiverSilenceRule(false, start + ONE_HOUR_MS + 1);
  const events = uiEvents.filter((e) => e.kind === 'receiver_silence');
  assert.equal(events.length, 1);
  assert.equal(events[0].hex, undefined);
  assert.equal(events[0].aircraft, undefined);
  assert.equal(typeof events[0].hours, 'number');
});

test('overhead does not emit a UI event, even though it publishes to ntfy/smart-home', () => {
  updateNotificationSettings({ overheadEnabled: true });
  setManualHome(HOME.lat, HOME.lon);
  rules.evaluateAircraftRules(aircraftFixture({ lat: 50.01, lon: 20.0 }));
  assert.equal(uiEvents.filter((e) => e.kind === 'overhead').length, 0);
});
