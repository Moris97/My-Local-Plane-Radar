import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = mkdtempSync(join(tmpdir(), 'mlpr-smart-home-test-'));
process.env.MLPR_DB_PATH = join(tmpDir, 'test.db');

const smartHome = await import('./smart-home.js');
const { updateSmartHomeSettings } = await import('./settings.js');

after(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// A fake MqttClient standing in for the real socket-based one -- records
// every publish() call and lets a test control whether connect() succeeds.
class FakeMqttClient {
  constructor(options) {
    this.options = options;
    this.published = [];
    this.connected = false;
    this.disconnected = false;
    FakeMqttClient.instances.push(this);
  }

  connect({ onConnect, onFailure } = {}) {
    this.connectCalled = true;
    if (FakeMqttClient.shouldFail) {
      onFailure?.('fake failure');
    } else {
      this.connected = true;
      onConnect?.();
    }
  }

  publish(topic, payload, opts) {
    this.published.push({ topic, payload, opts });
    return true;
  }

  disconnect() {
    this.disconnected = true;
    this.connected = false;
  }
}
FakeMqttClient.instances = [];
FakeMqttClient.shouldFail = false;

beforeEach(() => {
  FakeMqttClient.instances = [];
  FakeMqttClient.shouldFail = false;
  smartHome.setMqttClientFactory((options) => new FakeMqttClient(options));
  updateSmartHomeSettings({ enabled: false, brokerUrl: '', username: '', password: '', topicPrefix: 'mlpr' });
  smartHome.reconfigureSmartHome(); // tear down any client left over from a previous test
});

function aircraftFixture(overrides = {}) {
  return { hex: 'abc123', flight: 'LOT123 ', registration: 'SP-TEST', typeCode: 'A20N', altBaro: 3500, gs: 210, lat: 50.1, lon: 20.1, ...overrides };
}

test('reconfigureSmartHome does nothing when disabled', () => {
  updateSmartHomeSettings({ enabled: false, brokerUrl: 'mqtt://broker:1883' });
  smartHome.reconfigureSmartHome();
  assert.equal(FakeMqttClient.instances.length, 0);
});

test('reconfigureSmartHome does nothing when enabled but no broker URL set', () => {
  updateSmartHomeSettings({ enabled: true, brokerUrl: '' });
  smartHome.reconfigureSmartHome();
  assert.equal(FakeMqttClient.instances.length, 0);
});

test('reconfigureSmartHome connects and publishes retained "online" to the status topic on success', () => {
  updateSmartHomeSettings({ enabled: true, brokerUrl: 'mqtt://broker:1883', topicPrefix: 'mlpr' });
  smartHome.reconfigureSmartHome();
  assert.equal(FakeMqttClient.instances.length, 1);
  const instance = FakeMqttClient.instances[0];
  assert.equal(instance.connectCalled, true);
  assert.equal(instance.options.will.topic, 'mlpr/status');
  assert.equal(instance.options.will.payload, 'offline');
  assert.equal(instance.options.will.retain, true);
  assert.deepEqual(instance.published, [{ topic: 'mlpr/status', payload: 'online', opts: { retain: true } }]);
});

test('reconfigureSmartHome is a no-op when called again with unchanged settings', () => {
  updateSmartHomeSettings({ enabled: true, brokerUrl: 'mqtt://broker:1883' });
  smartHome.reconfigureSmartHome();
  smartHome.reconfigureSmartHome();
  assert.equal(FakeMqttClient.instances.length, 1, 'should not have reconnected');
});

test('reconfigureSmartHome tears down and reconnects when the broker URL actually changes', () => {
  updateSmartHomeSettings({ enabled: true, brokerUrl: 'mqtt://broker-a:1883' });
  smartHome.reconfigureSmartHome();
  const first = FakeMqttClient.instances[0];

  updateSmartHomeSettings({ brokerUrl: 'mqtt://broker-b:1883' });
  smartHome.reconfigureSmartHome();

  assert.equal(first.disconnected, true);
  assert.equal(FakeMqttClient.instances.length, 2);
});

test('publishSmartHomeEvent does nothing when smart home is disabled', () => {
  updateSmartHomeSettings({ enabled: false });
  smartHome.publishSmartHomeEvent({ reason: 'first_seen', aircraft: aircraftFixture() });
  assert.equal(FakeMqttClient.instances.length, 0);
});

test('publishSmartHomeEvent publishes a flat JSON payload to <prefix>/events/<reason>', () => {
  updateSmartHomeSettings({ enabled: true, brokerUrl: 'mqtt://broker:1883', topicPrefix: 'home' });
  smartHome.reconfigureSmartHome();
  const instance = FakeMqttClient.instances[0];
  instance.published.length = 0; // clear the "online" status publish from reconfigure

  smartHome.publishSmartHomeEvent({ reason: 'first_seen', aircraft: aircraftFixture() });

  assert.equal(instance.published.length, 1);
  assert.equal(instance.published[0].topic, 'home/events/first_seen');
  const payload = JSON.parse(instance.published[0].payload);
  assert.equal(payload.reason, 'first_seen');
  assert.equal(payload.hex, 'abc123');
  assert.equal(payload.registration, 'SP-TEST');
  assert.equal(payload.typeCode, 'A20N');
  assert.equal(payload.altitude, 3500);
  assert.equal(payload.speed, 210);
  assert.equal(payload.onGround, false);
  assert.equal(typeof payload.timestamp, 'number');
  // Never retained -- see smart-home.js's comment on why.
  assert.equal(instance.published[0].opts, undefined);
});

test('publishSmartHomeEvent includes matchedType/matchedValue for a watchlist event', () => {
  updateSmartHomeSettings({ enabled: true, brokerUrl: 'mqtt://broker:1883' });
  smartHome.reconfigureSmartHome();

  smartHome.publishSmartHomeEvent({
    reason: 'watchlist',
    aircraft: aircraftFixture({ typeCode: 'A388' }),
    matchedEntry: { matchType: 'type', matchValue: 'A388' },
  });

  const instance = FakeMqttClient.instances[0];
  const publishes = instance.published.filter((p) => p.topic === 'mlpr/events/watchlist');
  assert.equal(publishes.length, 1);
  const payload = JSON.parse(publishes[0].payload);
  assert.equal(payload.matchedType, 'type');
  assert.equal(payload.matchedValue, 'A388');
});

test('publishSmartHomeEvent reports ground-level altitude as 0, not the last airborne altBaro', () => {
  updateSmartHomeSettings({ enabled: true, brokerUrl: 'mqtt://broker:1883' });
  smartHome.reconfigureSmartHome();
  const instance = FakeMqttClient.instances[0];
  instance.published.length = 0;

  smartHome.publishSmartHomeEvent({ reason: 'first_seen', aircraft: aircraftFixture({ onGround: true, altBaro: undefined }) });

  const payload = JSON.parse(instance.published[0].payload);
  assert.equal(payload.altitude, 0);
  assert.equal(payload.onGround, true);
});

test('testSmartHomeConnection resolves ok:true on a successful CONNACK', async () => {
  FakeMqttClient.shouldFail = false;
  const result = await smartHome.testSmartHomeConnection({ brokerUrl: 'mqtt://broker:1883' });
  assert.deepEqual(result, { ok: true });
  // Uses its own temporary client, never the persistent singleton.
  assert.equal(FakeMqttClient.instances[0].disconnected, true);
});

test('testSmartHomeConnection resolves ok:false with the failure reason', async () => {
  FakeMqttClient.shouldFail = true;
  const result = await smartHome.testSmartHomeConnection({ brokerUrl: 'mqtt://broker:1883' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'fake failure');
});

test('testSmartHomeConnection resolves ok:false immediately when no broker URL is given', async () => {
  const result = await smartHome.testSmartHomeConnection({ brokerUrl: '' });
  assert.equal(result.ok, false);
  assert.equal(FakeMqttClient.instances.length, 0, 'should not even attempt a connection');
});

test('shutdownSmartHome publishes retained "offline" and disconnects the persistent client', () => {
  updateSmartHomeSettings({ enabled: true, brokerUrl: 'mqtt://broker:1883' });
  smartHome.reconfigureSmartHome();
  const instance = FakeMqttClient.instances[0];

  smartHome.shutdownSmartHome();

  const offlinePublish = instance.published.find((p) => p.payload === 'offline');
  assert.ok(offlinePublish, 'should have published offline');
  assert.equal(offlinePublish.topic, 'mlpr/status');
  assert.equal(offlinePublish.opts.retain, true);
  assert.equal(instance.disconnected, true);
});

test('shutdownSmartHome is a no-op when no client is connected', () => {
  assert.doesNotThrow(() => smartHome.shutdownSmartHome());
});

test('publishSmartHomeEvent returns false when smart home is disabled', () => {
  updateSmartHomeSettings({ enabled: false });
  const result = smartHome.publishSmartHomeEvent({ reason: 'first_seen', aircraft: aircraftFixture() });
  assert.equal(result, false);
});

test('publishSmartHomeEvent returns whatever the client publish reported (connected -> true)', () => {
  updateSmartHomeSettings({ enabled: true, brokerUrl: 'mqtt://broker:1883' });
  smartHome.reconfigureSmartHome();
  const result = smartHome.publishSmartHomeEvent({ reason: 'first_seen', aircraft: aircraftFixture() });
  assert.equal(result, true);
});

test('isSmartHomeConnected reflects the persistent client state', () => {
  assert.equal(smartHome.isSmartHomeConnected(), false, 'nothing configured yet');

  updateSmartHomeSettings({ enabled: true, brokerUrl: 'mqtt://broker:1883' });
  smartHome.reconfigureSmartHome();
  assert.equal(smartHome.isSmartHomeConnected(), true);

  smartHome.shutdownSmartHome();
  assert.equal(smartHome.isSmartHomeConnected(), false);
});
