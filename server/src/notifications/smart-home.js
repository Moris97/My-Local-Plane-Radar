// Smart-home (MQTT) delivery manager -- owns the single persistent
// MqttClient connection and turns first-seen/watchlist notification events
// (see rules.js) into structured JSON published to the configured broker,
// for Home Assistant (or any other MQTT-speaking system) to react to.
//
// Deliberately a THIRD, independent channel from ntfy (rules.js's
// `notify()`), not a generalization of it -- ntfy wants a human-readable
// title/message, smart-home wants a machine-readable event with the raw
// aircraft fields, so trying to share one payload shape would compromise
// both.
import { hostname } from 'node:os';
import { MqttClient } from './mqtt-client.js';
import { getSmartHomeSettings } from './settings.js';

const CLIENT_ID = `mlpr-${hostname()}`;
const TEST_TIMEOUT_MS = 5000;

// Injectable so tests can substitute a fake client without opening real
// sockets -- same pattern as rules.js's setNotifySender.
let mqttClientFactory = (options) => new MqttClient(options);

export function setMqttClientFactory(factory) {
  mqttClientFactory = factory;
}

let client = null;
// Fingerprint of the fields that actually require tearing down and
// reconnecting -- reconfigureSmartHome() is called after every settings
// PUT regardless of what changed, so this avoids reconnecting when e.g.
// only `enabled` flipped from true back to true (a no-op PUT).
let currentConfigKey = null;

function configKey(settings) {
  return JSON.stringify([settings.brokerUrl, settings.username, settings.password, settings.topicPrefix]);
}

function statusTopic(topicPrefix) {
  return `${topicPrefix}/status`;
}

// Called once at startup (index.js) and again after every settings change
// (server.js's PUT handler) -- idempotent when nothing relevant changed.
export function reconfigureSmartHome() {
  const settings = getSmartHomeSettings();

  if (!settings.enabled || !settings.brokerUrl) {
    if (client) {
      client.disconnect();
      client = null;
    }
    currentConfigKey = null;
    return;
  }

  const nextKey = configKey(settings);
  if (client && nextKey === currentConfigKey) return;

  client?.disconnect();

  client = mqttClientFactory({
    url: settings.brokerUrl,
    clientId: CLIENT_ID,
    username: settings.username || undefined,
    password: settings.password || undefined,
    // Standard MQTT "availability" pattern: the broker delivers this
    // retained message on our behalf if we disconnect uncleanly (crash,
    // network drop) -- see shutdownSmartHome() for the deliberate clean-
    // shutdown counterpart.
    will: { topic: statusTopic(settings.topicPrefix), payload: 'offline', retain: true },
  });
  currentConfigKey = nextKey;
  client.connect({
    onConnect: () => client.publish(statusTopic(settings.topicPrefix), 'online', { retain: true }),
  });
}

function aircraftFields(aircraft) {
  return {
    hex: aircraft.hex,
    flight: aircraft.flight ?? null,
    registration: aircraft.registration ?? null,
    typeCode: aircraft.typeCode ?? null,
    altitude: aircraft.onGround ? 0 : typeof aircraft.altBaro === 'number' ? aircraft.altBaro : null,
    onGround: !!aircraft.onGround,
    speed: typeof aircraft.gs === 'number' ? Math.round(aircraft.gs) : null,
    lat: typeof aircraft.lat === 'number' ? aircraft.lat : null,
    lon: typeof aircraft.lon === 'number' ? aircraft.lon : null,
  };
}

// `reason` is also the topic's last segment ('first_seen' | 'watchlist')
// so a Home Assistant automation can trigger on one specific topic instead
// of inspecting the payload -- see rules.js's two call sites. Flat payload
// (not nested under an `aircraft` key) so HA's Jinja templates can read
// `trigger.payload_json.typeCode` directly.
export function publishSmartHomeEvent({ reason, aircraft, matchedEntry }) {
  const settings = getSmartHomeSettings();
  if (!settings.enabled || !client) return;

  const payload = {
    reason,
    timestamp: Date.now(),
    ...aircraftFields(aircraft),
  };
  if (matchedEntry) {
    payload.matchedType = matchedEntry.matchType;
    payload.matchedValue = matchedEntry.matchValue;
  }

  // Never retained -- this is a discrete occurrence ("a watched aircraft
  // just appeared"), not persistent state; a retained message here would
  // make every fresh HA subscription immediately re-fire the last event.
  client.publish(`${settings.topicPrefix}/events/${reason}`, JSON.stringify(payload));
}

// Settings UI's "test connection" button: a SEPARATE, temporary connection
// (never touches the persistent `client` singleton above) using whatever's
// currently in the form -- lets broker credentials be verified before
// they're even saved. QoS 0 has no delivery acknowledgment, but CONNACK
// itself is a real, awaitable handshake independent of QoS, so "did the
// broker accept us" is genuinely testable even though "did it receive our
// last publish" isn't.
export function testSmartHomeConnection({ brokerUrl, username, password }) {
  return new Promise((resolve) => {
    if (!brokerUrl) {
      resolve({ ok: false, error: 'No broker URL configured' });
      return;
    }

    const testClient = mqttClientFactory({
      url: brokerUrl,
      clientId: `${CLIENT_ID}-test`,
      username: username || undefined,
      password: password || undefined,
    });

    const timeout = setTimeout(() => {
      testClient.disconnect();
      resolve({ ok: false, error: 'Timed out waiting for the broker to respond' });
    }, TEST_TIMEOUT_MS);

    testClient.connect({
      onConnect: () => {
        clearTimeout(timeout);
        testClient.disconnect();
        resolve({ ok: true });
      },
      onFailure: (error) => {
        clearTimeout(timeout);
        testClient.disconnect();
        resolve({ ok: false, error });
      },
    });
  });
}

// Graceful shutdown (index.js's SIGTERM/SIGINT handler, alongside the
// other flush-on-shutdown calls) -- proactively publishes "offline" rather
// than waiting for the broker to notice the TCP connection dropped and
// fall back to the Will. Same end result either way, just faster/more
// deliberate for a routine restart than a crash.
export function shutdownSmartHome() {
  if (!client) return;
  const settings = getSmartHomeSettings();
  client.publish(statusTopic(settings.topicPrefix), 'offline', { retain: true });
  client.disconnect();
  client = null;
  currentConfigKey = null;
}
