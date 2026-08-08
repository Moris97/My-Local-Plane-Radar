import { distanceKm } from '../range.js';

// An aircraft that keeps turning through more than a full circle while
// staying roughly in the same *region* of sky is usually doing something
// worth flagging: police/air-ambulance overwatch, a survey run, a
// search-and-rescue pattern, or a slow, wide military orbit (an AWACS or
// tanker anchor pattern -- reported live as something this missed
// entirely at the first, much tighter, radius this shipped with).
// "Simple detection" is literally the TODO.md wording this shipped from:
// the turn/position geometry below has no altitude/speed/aircraft-type
// heuristics in it at all -- just "has it turned through 360 degrees while
// staying roughly in one place." What *does* use aircraft type is
// isCirclingRelevant below, and deliberately for a different reason: not
// to guess "is this really circling", but to decide up front whose
// circling is worth anyone's attention (see its own comment).
//
// The turn geometry doesn't care whether that 360 degrees comes from a
// smooth circle or a "racetrack" (two straight legs joined by two
// same-direction turns, which is what a tanker/AWACS orbit and most
// holding patterns actually fly) -- a full racetrack lap is still a net
// signed 180+180 = 360 degrees, the straight legs simply contribute ~0
// each. What genuinely differs between a tight police orbit and a wide
// military one is *scale*: a leg on a large orbit can run tens of km and
// take many minutes, which is why both the window and the radius below
// are sized to the *largest* realistic case, not the smallest -- a fast,
// tight orbit still gets flagged in well under a minute regardless of how
// generous these are, since nothing here waits for the window to fill
// before checking (see recordAndCheckCircling).

// Sized for a large military-style orbit: a ~60 nm (110 km) leg at a
// typical orbit speed (~300 kt, ~9 km/min) takes on the order of 12
// minutes one-way, so a full racetrack lap (two legs, two turns) can run
// 25-30 minutes. 20 minutes doesn't cover the most extreme case with room
// to spare, but is a deliberate middle ground rather than chasing the
// largest orbit ever flown -- see CLAUDE.md if this needs revisiting
// against a real sighting.
const WINDOW_MS = 20 * 60 * 1000;
// Guards against a coincidental couple of noisy samples right after an
// aircraft is first seen looking like circling before there has been
// enough real time to tell anything -- require at least this much elapsed
// time across the window before ever answering true. Independent of
// WINDOW_MS's own sizing -- this only needs to be long enough to smooth
// out early positional noise, not to span a whole orbit.
const MIN_SPAN_MS = 45 * 1000;
const MIN_TURN_DEG = 360;
// A 60 nm leg racetrack has its two ends roughly 110 km apart -- the
// centroid sits near the middle, so either end can be ~55-60 km from it.
// 75 km leaves comfortable margin above that without approaching the
// scale of an actual point-to-point flight (hundreds of km even over a
// modest cruise segment), which is what keeps this a meaningful filter
// rather than a rubber stamp: the real discriminator is still the sustained
// signed 360-degree turn, genuinely rare outside an actual orbit; this
// radius only exists to reject a spiral that keeps drifting away while
// nominally still turning, not to pin down orbit size.
const MAX_RADIUS_KM = 75;
// Cheap safety net alongside the time-based pruning below (same shape as
// stats-history.js's own MAX_SAMPLES) -- bounds memory even if something
// somehow resent this aircraft far more often than the ~1/s poll rate
// would normally produce. Sized to comfortably hold a full WINDOW_MS at
// that rate (20 min * 60 = 1200), with margin.
const MAX_SAMPLES_PER_HEX = 1500;

// ADS-B emitter category values (readsb's own `category` field, e.g.
// 'A2', 'B1' -- see icon-classify.js's CATEGORY_MAP for the full table
// this project already relies on elsewhere) that this rule considers
// worth flagging when circling. Requested explicitly after the first
// version of this rule shipped and turned out to fire constantly on
// routine light-aircraft circuit training (a Cessna 172 and similar,
// category A1) -- not just gliders (B1, already excluded by the same
// mechanism). Rather than a denylist of "known uninteresting" categories
// (which would need updating every time a new uninteresting category came
// up -- balloons, parachutists, ultralights, drones...), this is the
// opposite: an allowlist of what *is* interesting, so anything not
// explicitly recognised is excluded by default.
//
// A2-A5 (small/large/high-vortex-large/heavy) covers regional turboprops,
// business jets, and airliners of every size the category standard
// distinguishes -- it does not split "airliner" from "bizjet" any finer
// than by weight, and neither does this. A7 (rotorcraft) is unconditional
// -- every helicopter, any size -- since a police/air-ambulance helicopter
// orbiting a scene is the original, flagship use case this whole rule was
// built for. A1 (light) and A6 (high performance -- aerobatic aircraft as
// much as fast jets, an unreliable proxy for "military") are deliberately
// left out of this set; a genuinely military aircraft of any size or
// category is still caught by the separate military check below, which
// doesn't depend on the category value at all.
const RELEVANT_CATEGORIES = new Set(['A2', 'A3', 'A4', 'A5', 'A7']);

// aircraft.military comes from the type/registration database (dbFlags
// bit 1, see normalize.js), not the live ADS-B broadcast -- it only
// resolves at all if the receiver has readsb's --db-file configured (see
// CLAUDE.md's Production deployment section); an install without it never
// sees this flag set for anyone, military or not, same pre-existing
// dependency the aircraft details panel's registration/type tiles already
// have.
export function isCirclingRelevant(aircraft) {
  if (aircraft.military) return true;
  return RELEVANT_CATEGORIES.has(aircraft.category);
}

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
