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
const { hasSeenAircraft, setConfigJSON } = await import('../db.js');
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

beforeEach(async () => {
  sent = [];
  resetCooldowns();
  rules.resetReceiverSilenceState();
  updateNotificationSettings({
    squawkEnabled: true,
    squawkCodes: { 7500: true, 7600: true, 7700: true },
    firstSeenEnabled: true,
    rangeRecordEnabled: true,
    watchedEnabled: true,
    receiverSilenceEnabled: true,
  });
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
