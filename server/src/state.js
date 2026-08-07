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

const tracked = new Map(); // hex -> { aircraft, lastPolledAt, lastPolledTick }

// Identifies "this tick" for the presence sweep below. Deliberately a
// counter rather than the tick's own Date.now(): two polls a millisecond
// apart would share a timestamp and make an aircraft absent from the second
// one look like it had just been polled. A second apart in production, so
// it would never have shown up there -- but the sweep's correctness has no
// business depending on how fast the poll loop happens to run.
let pollTick = 0;

function hasChanged(previous, next) {
  if (!previous) return true;
  return CHANGE_FIELDS.some((field) => previous[field] !== next[field]);
}

// Returns { updated, removed }:
//   updated -- aircraft the browser needs to redraw (see hasChanged)
//   removed -- hexes readsb has stopped reporting entirely, announced once
//
// `removed` exists because the browser cannot work this out for itself. A
// delta only carries aircraft whose tracked fields changed, so "no update
// for a while" is ambiguous client-side: it means either "this contact is
// dead" or "this contact is alive and simply isn't changing" (a parked
// aircraft with a steady squawk does exactly that -- see the note on
// recordRangeAndRegistrationSightings in index.js). Guessing wrong in
// either direction is visible: guess "dead" and live rows flicker in and
// out of the List, guess "alive" and dead ones linger. The server has the
// unambiguous answer, because readsb ages an aircraft out of aircraft.json
// on its own once it stops hearing it -- absence from the raw snapshot is
// that fact, and nothing else reports it.
export function applyRawSnapshot(rawSnapshot) {
  const rawAircraft = Array.isArray(rawSnapshot?.aircraft) ? rawSnapshot.aircraft : [];
  const now = Date.now();
  const tick = ++pollTick;
  const updated = [];
  const removed = [];

  for (const raw of rawAircraft) {
    const aircraft = normalizeAircraft(raw);
    if (!aircraft) continue;

    const entry = tracked.get(aircraft.hex);
    // An aircraft that was announced as removed is re-announced on its
    // return even when every tracked field compares equal -- the browser
    // has already dropped it, so "nothing changed" is precisely the case
    // that would otherwise leave it invisible until something did.
    if (hasChanged(entry?.aircraft, aircraft) || entry?.present === false) {
      updated.push(aircraft);
    }
    tracked.set(aircraft.hex, { aircraft, lastPolledAt: now, lastPolledTick: tick, present: true });
  }

  for (const [hex, entry] of tracked) {
    if (now - entry.lastPolledAt > EVICTION_MS) {
      tracked.delete(hex);
      continue;
    }
    // Announced once, on the tick readsb first stops offering it, rather
    // than every tick until eviction. The entry itself deliberately stays
    // for the full EVICTION_MS -- getTrackedAircraft() feeds range/antenna/
    // registration sampling and the trail-history eviction sweep, none of
    // which this is trying to change.
    if (entry.present && entry.lastPolledTick !== tick) {
      entry.present = false;
      removed.push(hex);
    }
  }

  return { updated, removed };
}

export function getTrackedAircraft() {
  return Array.from(tracked.values(), (entry) => entry.aircraft);
}

export function resetTrackedState() {
  tracked.clear();
}
