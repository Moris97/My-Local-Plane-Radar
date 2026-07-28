import { test } from 'node:test';
import assert from 'node:assert/strict';
import { distanceKm, bearingDegrees, findNearestFarthest } from './geo.js';

function assertClose(actual, expected, tolerance) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `expected ${actual} to be within ${tolerance} of ${expected}`);
}

test('distanceKm from a point to itself is 0', () => {
  assert.equal(distanceKm(50.0, 20.0, 50.0, 20.0), 0);
});

test('distanceKm: Warsaw to London is roughly the well-known ~1450 km great-circle distance', () => {
  assertClose(distanceKm(52.2297, 21.0122, 51.5074, -0.1278), 1450, 15);
});

test('bearingDegrees points due north (0°) for a point directly north', () => {
  assertClose(bearingDegrees(50.0, 20.0, 51.0, 20.0), 0, 0.01);
});

test('bearingDegrees points due east (90°) on the equator', () => {
  assertClose(bearingDegrees(0, 20.0, 0, 21.0), 90, 0.01);
});

test('findNearestFarthest returns nulls when there is no home location', () => {
  const result = findNearestFarthest([{ hex: 'a', lat: 51, lon: 20 }], null);
  assert.deepEqual(result, { nearest: null, farthest: null });
});

test('findNearestFarthest returns nulls when no aircraft has a position', () => {
  const result = findNearestFarthest([{ hex: 'a' }, { hex: 'b', lat: null, lon: null }], { lat: 50, lon: 20 });
  assert.deepEqual(result, { nearest: null, farthest: null });
});

test('findNearestFarthest picks the closest and farthest aircraft by distance to home', () => {
  const home = { lat: 50.0, lon: 20.0 };
  const near = { hex: 'near', lat: 50.05, lon: 20.0, registration: 'SP-NEAR' };
  const far = { hex: 'far', lat: 52.0, lon: 20.0, registration: 'SP-FAR' };
  const mid = { hex: 'mid', lat: 51.0, lon: 20.0, registration: 'SP-MID' };

  const result = findNearestFarthest([mid, far, near], home);
  assert.equal(result.nearest.hex, 'near');
  assert.equal(result.farthest.hex, 'far');
  assert.ok(result.nearest.distanceKm < result.farthest.distanceKm);
});

test('findNearestFarthest ignores aircraft with no position but still considers the rest', () => {
  const home = { lat: 50.0, lon: 20.0 };
  const noPos = { hex: 'nopos' };
  const withPos = { hex: 'withpos', lat: 50.1, lon: 20.0 };

  const result = findNearestFarthest([noPos, withPos], home);
  assert.equal(result.nearest.hex, 'withpos');
  assert.equal(result.farthest.hex, 'withpos');
});

test('findNearestFarthest with a single positioned aircraft: nearest and farthest are the same aircraft', () => {
  const home = { lat: 50.0, lon: 20.0 };
  const only = { hex: 'only', lat: 50.5, lon: 20.0 };
  const result = findNearestFarthest([only], home);
  assert.equal(result.nearest.hex, 'only');
  assert.equal(result.farthest.hex, 'only');
});
