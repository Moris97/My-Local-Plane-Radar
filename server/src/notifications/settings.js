import { randomInt } from 'node:crypto';
import { getConfig, setConfig, getConfigJSON, setConfigJSON } from '../db.js';

const SETTINGS_KEY = 'notificationSettings';
const NTFY_TOPIC_KEY = 'ntfyTopic';
const SMART_HOME_SETTINGS_KEY = 'smartHomeSettings';
// No 0/o or 1/l/i — those are the pairs people mistype when copying a code by hand.
const TOPIC_CHARSET = '23456789abcdefghjkmnpqrstuvwxyz';
const TOPIC_LENGTH = 8;

const DEFAULT_SETTINGS = {
  squawkEnabled: true,
  squawkCodes: { 7500: true, 7600: true, 7700: true },
  firstSeenEnabled: true,
  rangeRecordEnabled: true,
  // Master on/off for the whole watch list, alongside the per-entry
  // conditions. Added 2026-08-01 with the merged Notifications tab, which
  // lists every rule as a checkbox -- the watch list was the one rule with
  // no toggle of its own (entries were simply always live), which read as
  // an omission next to the other three. Defaults true so existing installs
  // behave exactly as before.
  watchedEnabled: true,
  // Receiver-health watchdog (rules.js's evaluateReceiverSilenceRule) --
  // defaults true like every other rule here, so an install that's never
  // touched this setting still gets the safety net.
  receiverSilenceEnabled: true,
  // Overhead-proximity alert (rules.js's evaluateOverheadRule) -- unlike
  // every rule above, this defaults to FALSE. Squawk/first-seen/watchlist/
  // silence all fire on something rare (an emergency, a genuinely new
  // aircraft, an explicit watch, an outage); this fires on plain proximity
  // to a fixed point, with no watch-list-style filter narrowing it down --
  // an install near a flight path, a GA circuit, or an approach corridor
  // could see this fire many times a day. An install upgrading to the
  // version that adds this should not suddenly get a burst of new
  // notifications it never asked for; the radius is also this install's own
  // call to make (an airport-adjacent receiver needs a smaller radius than
  // one in open countryside), so there is no sane default distance to
  // silently start firing at either.
  overheadEnabled: false,
  overheadRadiusKm: 2,
  // Circling detector (rules.js's evaluateAircraftRules, circling-
  // detector.js) -- defaults true like most rules here (squawk/first-seen/
  // watchlist/silence): unlike overhead-proximity, this fires on something
  // genuinely rare (a sustained 360-degree turn while staying in roughly
  // one place), not on plain presence, so it doesn't need the same opt-in
  // caution. Known exception worth remembering if this needs revisiting:
  // an install near a gliding club will see this fire on routine thermal
  // circling, which looks identical to this detector on purpose (see
  // circling-detector.js's own doc comment for why that isn't solved
  // algorithmically).
  circlingEnabled: true,
};

export function getNotificationSettings() {
  return { ...DEFAULT_SETTINGS, ...getConfigJSON(SETTINGS_KEY, {}) };
}

export function updateNotificationSettings(patch) {
  const current = getNotificationSettings();
  const next = {
    ...current,
    ...patch,
    squawkCodes: { ...current.squawkCodes, ...(patch.squawkCodes ?? {}) },
  };
  setConfigJSON(SETTINGS_KEY, next);
  return next;
}

function generateTopic() {
  let topic = '';
  for (let i = 0; i < TOPIC_LENGTH; i += 1) {
    topic += TOPIC_CHARSET[randomInt(TOPIC_CHARSET.length)];
  }
  return topic;
}

export function getNtfyTopic() {
  let topic = getConfig(NTFY_TOPIC_KEY);
  if (!topic) {
    topic = generateTopic();
    setConfig(NTFY_TOPIC_KEY, topic);
  }
  return topic;
}

export function regenerateNtfyTopic() {
  const topic = generateTopic();
  setConfig(NTFY_TOPIC_KEY, topic);
  return topic;
}

// Smart-home (MQTT) delivery -- a second, independent notification channel
// alongside ntfy above, only ever fed by the first-seen/watchlist rules
// (see rules.js/smart-home.js). Server-level infrastructure credentials
// (broker URL, username, password), not a per-browser preference -- stored
// here in SQLite same as everything else in this file, but gated behind
// requireSettingsAuth in server.js (like the Server tab's own port/home-
// location fields) rather than left open like the rest of this
// Notifications-tab-adjacent config, since a broker password is a real
// infrastructure secret, a different kind of sensitive than a random ntfy
// topic string.
const DEFAULT_SMART_HOME_SETTINGS = {
  enabled: false,
  brokerUrl: '', // e.g. mqtt://192.168.1.50:1883 or mqtts://host:8883 -- scheme picks plain/TLS
  username: '',
  password: '',
  topicPrefix: 'mlpr',
};

export function getSmartHomeSettings() {
  return { ...DEFAULT_SMART_HOME_SETTINGS, ...getConfigJSON(SMART_HOME_SETTINGS_KEY, {}) };
}

export function updateSmartHomeSettings(patch) {
  const next = { ...getSmartHomeSettings(), ...patch };
  setConfigJSON(SMART_HOME_SETTINGS_KEY, next);
  return next;
}
