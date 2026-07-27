import { test } from 'node:test';
import assert from 'node:assert/strict';
import { distanceKm } from './range.js';

function assertClose(actual, expected, tolerance) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `expected ${actual} to be within ${tolerance} of ${expected}`,
  );
}

test('distance from a point to itself is 0', () => {
  assert.equal(distanceKm(52.0, 20.0, 52.0, 20.0), 0);
});

test('a quarter of the equator matches (pi/2) * earth radius', () => {
  // Exact, coordinate-precision-free reference case: (0,0) to (0,90) is a
  // quarter of the equatorial circumference, computable in closed form for
  // whatever Earth radius the implementation uses.
  const expected = (Math.PI / 2) * 6371;
  assertClose(distanceKm(0, 0, 0, 90), expected, 0.01);
});

test('a quarter meridian (equator to pole) matches the same reference', () => {
  const expected = (Math.PI / 2) * 6371;
  assertClose(distanceKm(0, 0, 90, 0), expected, 0.01);
});

test('distance is symmetric', () => {
  const a = distanceKm(52.23, 21.01, 51.51, -0.13);
  const b = distanceKm(51.51, -0.13, 52.23, 21.01);
  assertClose(a, b, 0.001);
});

test('Warsaw to London is roughly the well-known ~1450 km great-circle distance', () => {
  const km = distanceKm(52.2297, 21.0122, 51.5074, -0.1278);
  assertClose(km, 1450, 15);
});
