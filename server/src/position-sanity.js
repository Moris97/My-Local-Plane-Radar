import { distanceKm } from './range.js';

// Rejects physically impossible jumps in position or altitude -- the odd
// decode error that puts an aircraft a few hundred km off its track (or
// drops it from cruise to the ground) for a tick before it comes back.
// Runs in state.js on every aircraft every poll, *before* change detection,
// so a rejected value never reaches anything downstream: not the map, not
// the server-side trail, not range/antenna statistics, not the rules.
//
// A rejected value is replaced with the last accepted one rather than
// removed: removing lat/lon would read downstream as "position lost" (a
// crossed-out pin in the List, a different code path on the map), which is
// a different story from "this reading was nonsense". The substituted
// position also gets its seenPos re-aged to the accepted fix's own decode
// time, so the browser's REMOVE_MS staleness logic keeps working on the
// real age of the position it is actually showing.
//
// Recovery: if the *reference* itself was the bad reading (e.g. the very
// first position seen for an aircraft was the glitch), every good fix after
// it would look impossible. So rejected readings are also compared with
// each other -- once CONFIRM_* consecutive rejects agree among themselves,
// the new track is taken as real and becomes the reference. For positions
// only genuinely new decodes count towards that (readsb re-reports its last
// position every poll with a growing seen_pos; a repeated glitch must not
// confirm itself).

const KT_TO_KM_PER_S = 1.852 / 3600;
// Well above anything that shows up on ADS-B (a fighter at altitude is
// ~1300 kt); the glitches this exists for imply tens of thousands of kt.
const MAX_GROUND_SPEED_KT = 1500;
// Headroom for positional noise over short intervals -- MLAT fixes are
// commonly off by several hundred metres.
const POSITION_SLACK_KM = 3;
// Faster than any real climb/descent, far below a garbled altitude jump
// (10,000 m to 0 in a second is ~2,000,000 ft/min).
const MAX_VERTICAL_RATE_FPM = 40000;
const ALTITUDE_SLACK_FT = 500;
const CONFIRM_POSITION = 2;
const CONFIRM_ALTITUDE = 3;
// Two readings whose decode times differ by less than this are the same
// fix re-reported (seen_pos has 0.1 s resolution).
const SAME_FIX_TOLERANCE_MS = 500;

const state = new Map(); // hex -> { pos, posRejects, alt, altRejects }

function plausiblePosition(from, to) {
  const dtS = Math.max(0, to.t - from.t) / 1000;
  const allowedKm = MAX_GROUND_SPEED_KT * KT_TO_KM_PER_S * dtS + POSITION_SLACK_KM;
  return distanceKm(from.lat, from.lon, to.lat, to.lon) <= allowedKm;
}

function plausibleAltitude(from, to) {
  const dtS = Math.max(0, to.t - from.t) / 1000;
  const allowedFt = (MAX_VERTICAL_RATE_FPM / 60) * dtS + ALTITUDE_SLACK_FT;
  return Math.abs(to.ft - from.ft) <= allowedFt;
}

// Shared accept/reject/confirm logic for both dimensions. `rejects` is the
// run of consecutive rejected readings, oldest first.
function judge(entry, key, rejectsKey, reading, plausible, confirmCount, isNewReading) {
  const reference = entry[key];
  if (!reference || plausible(reference, reading)) {
    entry[key] = reading;
    entry[rejectsKey] = [];
    return true;
  }

  const rejects = entry[rejectsKey];
  const last = rejects[rejects.length - 1];
  if (!last || !plausible(last, reading)) {
    entry[rejectsKey] = [reading];
  } else if (isNewReading(last, reading)) {
    rejects.push(reading);
  }
  if (entry[rejectsKey].length >= confirmCount) {
    entry[key] = reading;
    entry[rejectsKey] = [];
    return true;
  }
  return false;
}

export function sanitizeAircraft(aircraft, now = Date.now()) {
  let entry = state.get(aircraft.hex);
  if (!entry) {
    entry = { pos: null, posRejects: [], alt: null, altRejects: [] };
    state.set(aircraft.hex, entry);
  }

  if (typeof aircraft.lat === 'number' && typeof aircraft.lon === 'number') {
    const t = now - (typeof aircraft.seenPos === 'number' ? aircraft.seenPos * 1000 : 0);
    const reading = { lat: aircraft.lat, lon: aircraft.lon, t };
    const accepted = judge(entry, 'pos', 'posRejects', reading, plausiblePosition, CONFIRM_POSITION,
      (a, b) => b.t - a.t >= SAME_FIX_TOLERANCE_MS);
    if (!accepted) {
      logRejection(aircraft.hex, 'position', `${distanceKm(entry.pos.lat, entry.pos.lon, reading.lat, reading.lon).toFixed(1)} km jump`);
      aircraft.lat = entry.pos.lat;
      aircraft.lon = entry.pos.lon;
      aircraft.seenPos = Math.round((now - entry.pos.t) / 100) / 10;
    }
  }

  const altFt = aircraft.onGround ? 0 : aircraft.altBaro;
  if (typeof altFt === 'number') {
    const reading = { ft: altFt, onGround: aircraft.onGround === true, t: now };
    const accepted = judge(entry, 'alt', 'altRejects', reading, plausibleAltitude, CONFIRM_ALTITUDE,
      (a, b) => b.t > a.t);
    if (!accepted) {
      logRejection(aircraft.hex, 'altitude', `${entry.alt.ft} -> ${reading.ft} ft`);
      aircraft.onGround = entry.alt.onGround;
      aircraft.altBaro = entry.alt.onGround ? undefined : entry.alt.ft;
    }
  }

  return aircraft;
}

// Rare by nature, and the only way to see on a live receiver that this is
// doing anything -- a plain console line (same as airline-lookup.js's
// unknown-prefix log), no per-rejection storage.
function logRejection(hex, kind, detail) {
  console.warn(JSON.stringify({ kind: 'implausible_reading', hex, field: kind, detail }));
}

export function forgetAircraftSanity(hex) {
  state.delete(hex);
}

export function resetSanityState() {
  state.clear();
}
