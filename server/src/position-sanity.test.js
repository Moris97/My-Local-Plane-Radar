import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeAircraft, resetSanityState } from './position-sanity.js';
import { destinationPoint } from './range.js';

const HOME = { lat: 50.0, lon: 20.0 };
const T0 = 1_000_000_000_000;

// A cruising aircraft heading due east at ~450 kt (~0.23 km/s).
function cruise(i, overrides = {}) {
  const p = destinationPoint(HOME.lat, HOME.lon, 90, i * 0.23);
  return { hex: 'abc123', lat: p.lat, lon: p.lon, seenPos: 0, altBaro: 35000, onGround: false, ...overrides };
}

function feed(aircraft, i) {
  return sanitizeAircraft({ ...aircraft }, T0 + i * 1000);
}

beforeEach(() => {
  resetSanityState();
  console.warn = () => {};
});

test('a normal track passes through untouched', () => {
  for (let i = 0; i < 20; i++) {
    const input = cruise(i);
    const out = feed(input, i);
    assert.equal(out.lat, input.lat);
    assert.equal(out.lon, input.lon);
    assert.equal(out.altBaro, 35000);
  }
});

test('a single 300 km position jump is replaced by the last good position, then the track resumes', () => {
  for (let i = 0; i < 5; i++) feed(cruise(i), i);
  const good = cruise(4);
  const glitch = destinationPoint(HOME.lat, HOME.lon, 0, 300);
  const out = feed(cruise(5, { lat: glitch.lat, lon: glitch.lon }), 5);
  assert.equal(out.lat, good.lat);
  assert.equal(out.lon, good.lon);
  assert.equal(out.seenPos, 1); // re-aged to the accepted fix's own decode time

  const next = cruise(6);
  const resumed = feed(next, 6);
  assert.equal(resumed.lat, next.lat);
  assert.equal(resumed.lon, next.lon);
});

test('readsb re-reporting the same glitched fix never confirms it', () => {
  for (let i = 0; i < 5; i++) feed(cruise(i), i);
  const glitch = destinationPoint(HOME.lat, HOME.lon, 0, 300);
  for (let k = 0; k < 6; k++) {
    // same decode instant each time: seen_pos grows with the poll
    const out = feed(cruise(5, { lat: glitch.lat, lon: glitch.lon, seenPos: k }), 5 + k);
    assert.notEqual(out.lat, glitch.lat);
  }
});

test('a wrong first fix does not lock the aircraft out: two consistent new decodes take over', () => {
  const bad = destinationPoint(HOME.lat, HOME.lon, 0, 300);
  feed(cruise(0, { lat: bad.lat, lon: bad.lon }), 0);
  const first = feed(cruise(1), 1);
  assert.equal(first.lat, bad.lat); // still held back, one reading proves nothing
  const second = cruise(2);
  const out = feed(second, 2);
  assert.equal(out.lat, second.lat);
  assert.equal(out.lon, second.lon);
});

test('a long gap allows a correspondingly long real displacement', () => {
  feed(cruise(0), 0);
  // 10 minutes later, 100 km further along -- ~320 kt, perfectly plausible
  const later = destinationPoint(HOME.lat, HOME.lon, 90, 100);
  const out = feed(cruise(0, { lat: later.lat, lon: later.lon }), 600);
  assert.equal(out.lat, later.lat);
});

test('an altitude drop from cruise to the ground in one second is rejected', () => {
  for (let i = 0; i < 3; i++) feed(cruise(i), i);
  const toGround = feed(cruise(3, { altBaro: undefined, onGround: true }), 3);
  assert.equal(toGround.onGround, false);
  assert.equal(toGround.altBaro, 35000);
  const toZero = feed(cruise(4, { altBaro: 0 }), 4);
  assert.equal(toZero.altBaro, 35000);
  assert.equal(feed(cruise(5), 5).altBaro, 35000);
});

test('a real climb and a real landing flare pass', () => {
  let alt = 3000;
  for (let i = 0; i < 10; i++) {
    alt += 100; // 6000 ft/min
    assert.equal(feed(cruise(i, { altBaro: alt }), i).altBaro, alt);
  }
  resetSanityState();
  feed(cruise(0, { altBaro: 50, gs: 130 }), 0);
  const landed = feed(cruise(1, { altBaro: undefined, onGround: true }), 1);
  assert.equal(landed.onGround, true);
});

test('an altitude that genuinely changed is accepted after three consistent readings', () => {
  feed(cruise(0, { altBaro: 35000 }), 0); // bad first reference
  assert.equal(feed(cruise(1, { altBaro: 5000 }), 1).altBaro, 35000);
  assert.equal(feed(cruise(2, { altBaro: 5000 }), 2).altBaro, 35000);
  assert.equal(feed(cruise(3, { altBaro: 5000 }), 3).altBaro, 5000);
});

test('aircraft without position or altitude are left alone', () => {
  const out = sanitizeAircraft({ hex: 'modes1' }, T0);
  assert.equal(out.lat, undefined);
  assert.equal(out.altBaro, undefined);
});
