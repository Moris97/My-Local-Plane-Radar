import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  recordPosition,
  getTrail,
  getAllTrails,
  evictStaleTrails,
  resetTrailHistory,
} from './trail-history.js';

beforeEach(() => {
  resetTrailHistory();
});

function point(overrides = {}) {
  return { lat: 50, lon: 20, altBaro: 5000, onGround: false, t: Date.now(), ...overrides };
}

test('getTrail returns an empty array for an unknown hex', () => {
  assert.deepEqual(getTrail('nope'), []);
});

test('recordPosition appends to the trail for that hex', () => {
  recordPosition('abc', point({ lat: 50 }));
  recordPosition('abc', point({ lat: 50.1 }));
  const trail = getTrail('abc');
  assert.equal(trail.length, 2);
  assert.equal(trail[0].lat, 50);
  assert.equal(trail[1].lat, 50.1);
});

test('trails for different hexes are independent', () => {
  recordPosition('abc', point());
  recordPosition('def', point());
  recordPosition('def', point());
  assert.equal(getTrail('abc').length, 1);
  assert.equal(getTrail('def').length, 2);
});

test('trail length is capped so it cannot grow unbounded', () => {
  for (let i = 0; i < 1050; i += 1) {
    recordPosition('abc', point({ lat: 50 + i * 0.001 }));
  }
  const trail = getTrail('abc');
  assert.equal(trail.length, 1000);
  assert.equal(trail[trail.length - 1].lat, 50 + 1049 * 0.001);
});

test('getAllTrails returns every tracked hex', () => {
  recordPosition('abc', point());
  recordPosition('def', point());
  const all = getAllTrails();
  assert.deepEqual(Object.keys(all).sort(), ['abc', 'def']);
});

test('evictStaleTrails removes hexes not in the active set', () => {
  recordPosition('abc', point());
  recordPosition('def', point());
  evictStaleTrails(new Set(['abc']));
  assert.equal(getTrail('abc').length, 1);
  assert.deepEqual(getTrail('def'), []);
});

test('evictStaleTrails keeps everything when all hexes are still active', () => {
  recordPosition('abc', point());
  recordPosition('def', point());
  evictStaleTrails(new Set(['abc', 'def']));
  assert.equal(getTrail('abc').length, 1);
  assert.equal(getTrail('def').length, 1);
});
