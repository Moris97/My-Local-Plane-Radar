import { normalizeAircraft } from './normalize.js';

const EVICTION_MS = 5 * 60 * 1000;

// Fields whose change forces an immediate resend to the browser. Anything
// not listed here (receiver/signal quality metrics, computed secondary
// stats) is "volatile" -- still stored and sent whenever a tracked field
// also changes, just not enough on its own to trigger a resend. Arrays
// (e.g. navModes) can't safely go here: normalizeAircraft allocates a new
// array every poll, so a reference-equality check would always see them as
// "changed" and force a resend every tick.
const CHANGE_FIELDS = [
  'lat', 'lon', 'altBaro', 'altGeom', 'gs', 'track', 'baroRate',
  'onGround', 'squawk', 'flight', 'category', 'registration',
  'typeCode', 'desc', 'military', 'interesting', 'pia', 'ladd',
  'ias', 'tas', 'mach', 'geomRate', 'trackRate', 'roll',
  'magHeading', 'trueHeading', 'navQnh', 'navAltitudeMcp',
  'navAltitudeFms', 'navHeading', 'emergency', 'alert', 'spi',
  'version', 'sourceType',
];

const tracked = new Map(); // hex -> { aircraft, lastPolledAt }

function hasChanged(previous, next) {
  if (!previous) return true;
  return CHANGE_FIELDS.some((field) => previous[field] !== next[field]);
}

export function applyRawSnapshot(rawSnapshot) {
  const rawAircraft = Array.isArray(rawSnapshot?.aircraft) ? rawSnapshot.aircraft : [];
  const now = Date.now();
  const updated = [];

  for (const raw of rawAircraft) {
    const aircraft = normalizeAircraft(raw);
    if (!aircraft) continue;

    const entry = tracked.get(aircraft.hex);
    if (hasChanged(entry?.aircraft, aircraft)) {
      updated.push(aircraft);
    }
    tracked.set(aircraft.hex, { aircraft, lastPolledAt: now });
  }

  for (const [hex, entry] of tracked) {
    if (now - entry.lastPolledAt > EVICTION_MS) {
      tracked.delete(hex);
    }
  }

  return updated;
}

export function getTrackedAircraft() {
  return Array.from(tracked.values(), (entry) => entry.aircraft);
}

export function resetTrackedState() {
  tracked.clear();
}
