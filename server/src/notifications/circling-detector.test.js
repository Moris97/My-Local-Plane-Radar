import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { recordAndCheckCircling, evictStaleCircling, resetCirclingHistory } from './circling-detector.js';
import { destinationPoint } from '../range.js';

// Placeholder coordinates only -- never a real receiver location.
const CENTER = { lat: 50.0, lon: 20.0 };

beforeEach(() => {
  resetCirclingHistory();
});

// One synthetic sample of a genuine, tight orbit: track advances by a
// fixed step each tick, position stays close to CENTER (destinationPoint
// keeps it exactly radiusKm out, so the whole path sits on a small circle)
// -- this is not required by the algorithm itself (it only ever looks at
// cumulative track change and distance-from-centroid independently), but
// it is what a *real* circling aircraft's samples would actually look
// like, so the tests read as a real scenario rather than two unrelated
// synthetic signals.
function orbitSample(i, { trackStep = 8, radiusKm = 0.4, tStepMs = 1000, startTrack = 0 } = {}) {
  const trackDeg = (startTrack + i * trackStep + 3600) % 360;
  const { lat, lon } = destinationPoint(CENTER.lat, CENTER.lon, trackDeg, radiusKm);
  return { t: i * tStepMs, trackDeg, lat, lon };
}

function feed(hex, samples) {
  let result = false;
  for (const s of samples) {
    result = recordAndCheckCircling(hex, { track: s.trackDeg, lat: s.lat, lon: s.lon }, s.t);
  }
  return result;
}

test('detects a genuine sustained orbit', () => {
  // 50 samples * 8 deg = 400 deg of cumulative turn over 49s -- comfortably
  // past both MIN_TURN_DEG (360) and MIN_SPAN_MS (45s).
  const samples = Array.from({ length: 50 }, (_, i) => orbitSample(i));
  assert.equal(feed('orbit1', samples), true);
});

test('does not fire before the cumulative turn reaches 360 degrees', () => {
  // 8 deg/sample * 40 samples = 320 deg -- short of the threshold, even
  // though the span is already well past MIN_SPAN_MS.
  const samples = Array.from({ length: 40 }, (_, i) => orbitSample(i));
  assert.equal(feed('orbit2', samples), false);
});

test('does not fire before enough time has elapsed, even with enough cumulative turn', () => {
  // Same 400-degree turn as the first test, but compressed into a 9-second
  // span (tStepMs=200) -- MIN_SPAN_MS (45s) should block it regardless of
  // how much the heading has nominally rotated.
  const samples = Array.from({ length: 50 }, (_, i) => orbitSample(i, { tStepMs: 200 }));
  assert.equal(feed('orbit3', samples), false);
});

test('straight, level flight never triggers, however long it runs', () => {
  const samples = Array.from({ length: 200 }, (_, i) => {
    const trackDeg = 90;
    // 0.001 deg longitude per tick at this latitude is genuine forward
    // travel, not jitter -- after 200 samples this aircraft is many km
    // from where it started.
    return { t: i * 1000, trackDeg, lat: CENTER.lat, lon: CENTER.lon + i * 0.001 };
  });
  assert.equal(feed('straight1', samples), false);
});

test('S-turns cancel out and never accumulate, even though the aircraft keeps turning', () => {
  const samples = [];
  let track = 90;
  for (let i = 0; i < 100; i++) {
    // Alternates +90/-90 every 5 samples -- genuinely turning back and
    // forth, but signed-summing these cancels rather than accumulating,
    // which is the whole point of using a *signed* cumulative turn instead
    // of a sum of absolute deltas.
    if (i % 10 === 0) track = track === 90 ? 180 : 90;
    samples.push({ t: i * 1000, trackDeg: track, lat: CENTER.lat, lon: CENTER.lon + i * 0.0005 });
  }
  assert.equal(feed('sturn1', samples), false);
});

test('a spiral that drifts away from its own centroid does not count as circling', () => {
  // Same cumulative turn as the genuine-orbit case, but radiusKm grows
  // with each sample instead of staying fixed -- the aircraft really is
  // turning through 360+ degrees, just while moving steadily away rather
  // than staying "roughly in the same place". Has to drift well past
  // MAX_RADIUS_KM (75) by the last sample, not just past the old, much
  // tighter value this shipped with initially.
  const samples = Array.from({ length: 50 }, (_, i) => orbitSample(i, { radiusKm: 1 + i * 2.5 }));
  assert.equal(feed('spiral1', samples), false);
});

test('a wide, slow military-style orbit (AWACS/tanker anchor pattern scale) is still detected', () => {
  // 40 km radius, one full lap over ~19 minutes (64 * 18s) -- reported
  // live as a real gap: the original 3 km radius this shipped with would
  // have rejected this outright, even though it is exactly the kind of
  // sustained, deliberate orbit the rule exists to catch, just flown much
  // wider than a police helicopter or a glider. 65 samples * 6 deg/step
  // gives 64 deltas -> 384 deg of cumulative turn, comfortably past the
  // 360 threshold; the full span (64 * 18s ~= 19.2 min) still fits inside
  // the 20-minute window with a little room to spare.
  const samples = Array.from({ length: 65 }, (_, i) => orbitSample(i, { trackStep: 6, radiusKm: 40, tStepMs: 18000 }));
  assert.equal(feed('wideorbit1', samples), true);
});

test('a racetrack pattern (two straight legs, two same-direction turns) is detected the same as a smooth circle', () => {
  // The geometry AWACS/tanker orbits and most holding patterns actually
  // fly: constant heading for a long straight leg, a sharp ~180-degree
  // turn, the reverse heading for the return leg, another ~180-degree
  // turn -- net 360 degrees per lap, same as a circle, just not shaped
  // like one. Legs run perpendicular to the turn direction so the whole
  // shape stays within MAX_RADIUS_KM of its own centroid.
  const legLat = CENTER.lat;
  const samples = [];
  let t = 0;
  const pushLeg = (trackDeg, lonStart, lonEnd, steps) => {
    for (let i = 0; i <= steps; i++) {
      const lon = lonStart + ((lonEnd - lonStart) * i) / steps;
      samples.push({ t, trackDeg, lat: legLat, lon });
      t += 5000;
    }
  };
  // `toDegUnwrapped` is allowed to exceed 360 (only wrapped once, at the
  // very end) so both turns keep rotating the *same* direction -- using a
  // plain 270 for the second turn's target would interpolate the "short
  // way" back (270 -> 90 decreasing), which is the opposite rotational
  // sense from the first turn and nets to zero over the full lap instead
  // of a real racetrack's 360. This is exactly the mistake a first draft
  // of this test made, caught by the assertion failing rather than by
  // reasoning about it up front.
  const pushTurn = (fromDeg, toDegUnwrapped, lat, lon, steps) => {
    for (let i = 1; i <= steps; i++) {
      const trackDeg = (fromDeg + ((toDegUnwrapped - fromDeg) * i) / steps + 360) % 360;
      samples.push({ t, trackDeg, lat, lon });
      t += 2000;
    }
  };
  const LON0 = CENTER.lon;
  const LON1 = CENTER.lon + 0.5; // roughly a few tens of km at this latitude
  pushLeg(90, LON0, LON1, 20); // outbound leg, heading east
  pushTurn(90, 270, legLat, LON1, 10); // +180, turning right at the far end
  pushLeg(270, LON1, LON0, 20); // return leg, heading west
  pushTurn(270, 450, legLat, LON0, 10); // +180 more, same rotational sense (270 -> 360/0 -> 90)
  assert.equal(feed('racetrack1', samples), true);
});

test('a missing track/position sample is skipped without resetting progress', () => {
  const first25 = Array.from({ length: 25 }, (_, i) => orbitSample(i));
  let result = feed('gap1', first25);
  assert.equal(result, false); // 25 * 8 = 200 deg, not there yet

  // A position-less Mode-S ping mid-orbit -- must not wipe the window.
  result = recordAndCheckCircling('gap1', { track: undefined, lat: undefined, lon: undefined }, 25000);
  assert.equal(result, false);

  const rest = Array.from({ length: 25 }, (_, i) => orbitSample(25 + i));
  result = feed('gap1', rest);
  assert.equal(result, true); // the gap didn't cost the accumulated turn
});

test('evictStaleCircling actually clears accumulated history, not just a bookkeeping flag', () => {
  const samples = Array.from({ length: 40 }, (_, i) => orbitSample(i)); // 320 deg, short of the threshold
  feed('evict1', samples);

  evictStaleCircling(new Set()); // 'evict1' is not in the active set

  // If eviction were a no-op, these next 10 samples (80 more degrees, 400
  // total) would cross the threshold. Since the window was actually
  // cleared, this restarts from zero and falls well short again.
  const more = Array.from({ length: 10 }, (_, i) => orbitSample(40 + i));
  assert.equal(feed('evict1', more), false);
});

test('evictStaleCircling leaves an aircraft still in the active set untouched', () => {
  const samples = Array.from({ length: 40 }, (_, i) => orbitSample(i));
  feed('keep1', samples);

  evictStaleCircling(new Set(['keep1']));

  const more = Array.from({ length: 10 }, (_, i) => orbitSample(40 + i));
  assert.equal(feed('keep1', more), true);
});
