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
  // than staying "roughly in the same place".
  const samples = Array.from({ length: 50 }, (_, i) => orbitSample(i, { radiusKm: 0.2 + i * 0.3 }));
  assert.equal(feed('spiral1', samples), false);
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
