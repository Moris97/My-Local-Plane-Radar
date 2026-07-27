import { hasSeenAircraft, markAircraftSeen, getConfig, setConfig } from '../db.js';
import { getNotificationSettings, getNtfyTopic } from './settings.js';
import { isOnCooldown, markNotified } from './cooldown.js';
import { sendNtfyNotification } from './ntfy.js';
import { getWatchList } from './watchlist.js';

const SQUAWK_MEANINGS = {
  7500: 'Hijack',
  7600: 'Radio failure',
  7700: 'Emergency',
};

const ALL_TIME_MAX_RANGE_KEY = 'allTimeMaxRangeKm';

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

export function evaluateAircraftRules(aircraft) {
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
    markAircraftSeen(aircraft.hex);
    if (settings.firstSeenEnabled) {
      notify({
        title: 'First time seen',
        message: aircraftLabel(aircraft),
        priority: 3,
        tags: ['eye'],
      });
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
    }
  }
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
