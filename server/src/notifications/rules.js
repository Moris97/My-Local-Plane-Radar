import { hasSeenAircraft, markAircraftSeen, getConfig, setConfig } from '../db.js';
import { getNotificationSettings, getNtfyTopic } from './settings.js';
import { isOnCooldown, markNotified } from './cooldown.js';
import { sendNtfyNotification } from './ntfy.js';

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

function aircraftLabel(aircraft) {
  const parts = [aircraft.flight || aircraft.hex];
  if (aircraft.registration) parts.push(aircraft.registration);
  if (aircraft.typeCode) parts.push(aircraft.typeCode);
  if (aircraft.category) parts.push(`cat ${aircraft.category}`);
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
