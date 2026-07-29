import { hasSeenAircraft, markAircraftSeen, getConfig, setConfig } from '../db.js';
import { getNotificationSettings, getNtfyTopic } from './settings.js';
import { isOnCooldown, markNotified } from './cooldown.js';
import { sendNtfyNotification } from './ntfy.js';
import { getWatchList } from './watchlist.js';
import { publishSmartHomeEvent } from './smart-home.js';

const SQUAWK_MEANINGS = {
  7500: 'Hijack',
  7600: 'Radio failure',
  7700: 'Emergency',
};

const ALL_TIME_MAX_RANGE_KEY = 'allTimeMaxRangeKm';

// readsb can take a poll tick or two to decode an aircraft's callsign and
// position after first hearing its Mode-S address -- firing "first time
// seen" on the very first tick produced notifications like "c48e893" or
// "4892c6 · 484 kt" with fields still missing (reported live, 2026-07-27;
// TODO.md tracked this as deferred until now). hex -> ms epoch of the first
// tick this hex was noticed but not yet notified/recorded -- in-memory
// only, same as cooldown.js's lastNotifiedAt (hard rule 6: fine to lose on
// restart, a still-pending hex just gets treated as new again). A hex that
// never gets a second look within the delay (a one-off Mode-S blip) simply
// never resolves -- no notification, and never written to seen_aircraft
// either, which is arguably more correct than the old immediate-fire
// behavior: we never actually got a good look at it.
const FIRST_SEEN_DELAY_MS = 3000; // a few POLL_INTERVAL_MS (1000ms) ticks
const pendingFirstSeen = new Map();

let notifySender = sendNtfyNotification;

export function setNotifySender(fn) {
  notifySender = fn;
}

function notify(payload) {
  return notifySender(getNtfyTopic(), payload);
}

const WATCH_FIELD_BY_MATCH_TYPE = {
  type: 'typeCode',
  registration: 'registration',
  flight: 'flight',
};

function satisfiesAltitudeCondition(aircraft, entry) {
  if (!entry.altitudeOperator) return true;

  const altitude = aircraft.onGround ? 0 : aircraft.altBaro;
  if (typeof altitude !== 'number') return false;

  if (entry.altitudeOperator === 'below') return altitude < entry.altitudeValue;
  if (entry.altitudeOperator === 'above') return altitude > entry.altitudeValue;
  return true;
}

function matchesWatchEntry(aircraft, entry) {
  const field = aircraft[WATCH_FIELD_BY_MATCH_TYPE[entry.matchType]];
  if (!field || field.toLowerCase() !== entry.matchValue.toLowerCase()) return false;
  return satisfiesAltitudeCondition(aircraft, entry);
}

function formatAltitude(aircraft) {
  if (aircraft.onGround) return 'ground';
  return typeof aircraft.altBaro === 'number' ? `${aircraft.altBaro} ft` : null;
}

function formatSpeed(aircraft) {
  return typeof aircraft.gs === 'number' ? `${Math.round(aircraft.gs)} kt` : null;
}

// The notification's title already carries the reason (squawk code, "First
// time seen", "Watched aircraft") -- this is just the aircraft identity +
// current altitude/speed, so registration/type/flight/altitude/speed are
// always present when available.
function aircraftLabel(aircraft) {
  const parts = [aircraft.flight || aircraft.hex];
  if (aircraft.registration) parts.push(aircraft.registration);
  if (aircraft.typeCode) parts.push(aircraft.typeCode);
  const altitude = formatAltitude(aircraft);
  if (altitude) parts.push(altitude);
  const speed = formatSpeed(aircraft);
  if (speed) parts.push(speed);
  return parts.join(' · ');
}

// `now` is injectable (defaults to the real clock) purely so tests can
// exercise FIRST_SEEN_DELAY_MS deterministically without real waits or
// fake timers -- index.js's only call site never passes it.
export function evaluateAircraftRules(aircraft, now = Date.now()) {
  const settings = getNotificationSettings();

  if (settings.squawkEnabled && aircraft.squawk && settings.squawkCodes[aircraft.squawk]) {
    if (!isOnCooldown('squawk', aircraft.hex)) {
      markNotified('squawk', aircraft.hex);
      notify({
        title: `Squawk ${aircraft.squawk} — ${SQUAWK_MEANINGS[aircraft.squawk] ?? 'Alert'}`,
        message: aircraftLabel(aircraft),
        priority: 5,
        tags: ['rotating_light'],
      });
    }
  }

  if (!hasSeenAircraft(aircraft.hex)) {
    const firstNoticedAt = pendingFirstSeen.get(aircraft.hex);
    if (firstNoticedAt === undefined) {
      pendingFirstSeen.set(aircraft.hex, now);
    } else if (now - firstNoticedAt >= FIRST_SEEN_DELAY_MS) {
      pendingFirstSeen.delete(aircraft.hex);
      markAircraftSeen(aircraft.hex);
      if (settings.firstSeenEnabled) {
        notify({
          title: 'First time seen',
          message: aircraftLabel(aircraft),
          priority: 3,
          tags: ['eye'],
        });
        // Smart-home (MQTT) is a separate, independent delivery channel --
        // deliberately only wired to these two rules (first-seen,
        // watchlist) for now, not squawk/range-record, per explicit scope.
        // No-ops on its own if smart-home isn't enabled/configured.
        publishSmartHomeEvent({ reason: 'first_seen', aircraft });
      }
    }
  }

  if (!isOnCooldown('watched', aircraft.hex)) {
    const matchedEntry = getWatchList().find((entry) => matchesWatchEntry(aircraft, entry));
    if (matchedEntry) {
      markNotified('watched', aircraft.hex);
      notify({
        title: 'Watched aircraft',
        message: aircraftLabel(aircraft),
        priority: 4,
        tags: ['eyes'],
      });
      publishSmartHomeEvent({ reason: 'watchlist', aircraft, matchedEntry });
    }
  }
}

// Evicts pending hexes that never resolved within maxAgeMs (a one-off
// Mode-S blip that was never heard again) -- otherwise pendingFirstSeen
// would grow unbounded over an install's lifetime. Mirrors cooldown.js's
// pruneCooldowns; called on the same hourly interval from index.js.
export function prunePendingFirstSeen(maxAgeMs = 10 * 60 * 1000) {
  const now = Date.now();
  for (const [hex, at] of pendingFirstSeen) {
    if (now - at > maxAgeMs) pendingFirstSeen.delete(hex);
  }
}

// Reads the same all-time record evaluateRangeRecordRule below maintains --
// used by Stats' "Od początku" section, which wants a single all-time max
// range number without reimplementing this tracking a second time.
export function getAllTimeMaxRangeKm() {
  return Number(getConfig(ALL_TIME_MAX_RANGE_KEY) ?? 0);
}

export function evaluateRangeRecordRule(maxRangeKm) {
  if (typeof maxRangeKm !== 'number') return;

  const settings = getNotificationSettings();
  const record = Number(getConfig(ALL_TIME_MAX_RANGE_KEY) ?? 0);
  if (maxRangeKm <= record) return;

  setConfig(ALL_TIME_MAX_RANGE_KEY, String(maxRangeKm));
  if (settings.rangeRecordEnabled) {
    notify({
      title: 'New range record',
      message: `${maxRangeKm.toFixed(0)} km (previous: ${record.toFixed(0)} km)`,
      priority: 4,
      tags: ['dash'],
    });
  }
}
