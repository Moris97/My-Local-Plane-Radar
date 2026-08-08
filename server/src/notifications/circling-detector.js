import { distanceKm } from '../range.js';

// An aircraft that keeps turning through more than a full circle while
// staying roughly in the same patch of sky is usually doing something
// worth flagging -- police/air-ambulance overwatch, a survey run, a
// search-and-rescue pattern -- rather than just flying somewhere.
// "Simple detection" is literally the TODO.md wording this shipped from:
// no altitude/speed/aircraft-type heuristics, just "has it turned through
// 360 degrees while staying within a few km of where it started."
//
// Known false-positive, not solved here: a glider thermalling to gain
// height circles just as tightly and just as persistently as anything
// genuinely worth flagging. An install near a gliding club should expect
// this to fire on completely routine local flying -- there is no clean
// altitude/speed threshold that reliably tells the two apart, so this is
// documented rather than guessed at (see CLAUDE.md).

const WINDOW_MS = 5 * 60 * 1000;
// A worst-case slow loiter still has to complete at least one full turn
// inside WINDOW_MS to ever be detected -- five minutes comfortably covers
// even a wide, gentle search circle, while staying well clear of "heading
// gradually drifted over a long straight flight" accumulating by accident.
const MIN_SPAN_MS = 45 * 1000;
// Guards against a coincidental couple of noisy samples right after an
// aircraft is first seen looking like circling before there has been
// enough real time to tell anything -- require at least this much elapsed
// time across the window before ever answering true.
const MIN_TURN_DEG = 360;
const MAX_RADIUS_KM = 3;
// Cheap safety net alongside the time-based pruning below (same shape as
// stats-history.js's own MAX_SAMPLES) -- bounds memory even if something
// somehow resent this aircraft far more often than the ~1/s poll rate
// would normally produce.
const MAX_SAMPLES_PER_HEX = 600;

const history = new Map(); // hex -> [{ t, trackDeg, lat, lon }, ...]

// Shortest signed rotation from `fromDeg` to `toDeg`, in (-180, 180] --
// e.g. 350 -> 10 is +20, not -340. Summing these across consecutive
// samples is what makes S-turns (which alternate sign and cancel out) read
// differently from a real, one-direction orbit (which keeps adding up).
function signedTurnDelta(fromDeg, toDeg) {
  return ((toDeg - fromDeg + 540) % 360) - 180;
}

function average(values) {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

// Called once per aircraft per tick it's actually resent (the same
// evaluateAircraftRules call site as every other rule) -- records this
// reading and returns whether the aircraft is *currently* circling,
// independent of any notification cooldown (see rules.js's alertKinds for
// why that distinction matters -- the live map glow needs an honest
// per-tick answer, not one throttled to once per cooldown window). Missing
// track/position simply answers false without touching the recorded
// history -- a single position-less Mode-S ping mid-orbit shouldn't reset
// the window.
export function recordAndCheckCircling(hex, aircraft, now = Date.now()) {
  if (typeof aircraft.track !== 'number' || typeof aircraft.lat !== 'number' || typeof aircraft.lon !== 'number') {
    return false;
  }

  let samples = history.get(hex);
  if (!samples) {
    samples = [];
    history.set(hex, samples);
  }
  samples.push({ t: now, trackDeg: aircraft.track, lat: aircraft.lat, lon: aircraft.lon });

  const cutoff = now - WINDOW_MS;
  while (samples.length > 0 && samples[0].t < cutoff) samples.shift();
  if (samples.length > MAX_SAMPLES_PER_HEX) samples.splice(0, samples.length - MAX_SAMPLES_PER_HEX);

  if (samples.length < 2) return false;
  if (samples[samples.length - 1].t - samples[0].t < MIN_SPAN_MS) return false;

  let cumulativeTurnDeg = 0;
  for (let i = 1; i < samples.length; i++) {
    cumulativeTurnDeg += signedTurnDelta(samples[i - 1].trackDeg, samples[i].trackDeg);
  }
  if (Math.abs(cumulativeTurnDeg) < MIN_TURN_DEG) return false;

  const centroidLat = average(samples.map((s) => s.lat));
  const centroidLon = average(samples.map((s) => s.lon));
  const maxRadiusKm = Math.max(...samples.map((s) => distanceKm(centroidLat, centroidLon, s.lat, s.lon)));
  return maxRadiusKm <= MAX_RADIUS_KM;
}

// Mirrors trail-history.js's own evictStaleTrails -- called from the same
// periodic sweep (index.js), keyed off the same "still in state.js's
// tracked set" hex set every other per-hex history map in this app uses.
export function evictStaleCircling(activeHexes) {
  for (const hex of history.keys()) {
    if (!activeHexes.has(hex)) history.delete(hex);
  }
}

export function resetCirclingHistory() {
  history.clear();
}
