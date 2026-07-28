import { test } from 'node:test';
import assert from 'node:assert/strict';
import { distanceKm, bearingDegrees, destinationPoint, isRangeEligible } from './range.js';

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

test('bearingDegrees points due north (0°) for a point directly north', () => {
  assertClose(bearingDegrees(50.0, 20.0, 51.0, 20.0), 0, 0.01);
});

test('bearingDegrees points due east (90°) for a point directly east on the equator', () => {
  // Off the equator, "due east" curves along a great circle and isn't
  // exactly 90° -- the equator is the one latitude where it is, avoiding
  // picking an arbitrary tolerance for that curvature.
  assertClose(bearingDegrees(0, 20.0, 0, 21.0), 90, 0.01);
});

test('bearingDegrees points due south (180°) for a point directly south', () => {
  assertClose(bearingDegrees(50.0, 20.0, 49.0, 20.0), 180, 0.01);
});

test('bearingDegrees points due west (270°) for a point directly west on the equator', () => {
  assertClose(bearingDegrees(0, 20.0, 0, 19.0), 270, 0.01);
});

test('bearingDegrees is always within [0, 360)', () => {
  for (const [lat1, lon1, lat2, lon2] of [
    [52.23, 21.01, 51.51, -0.13],
    [-33.87, 151.21, 40.71, -74.01],
    [10, -170, -10, 170],
  ]) {
    const bearing = bearingDegrees(lat1, lon1, lat2, lon2);
    assert.ok(bearing >= 0 && bearing < 360, `expected ${bearing} to be within [0, 360)`);
  }
});

test('destinationPoint travelling due north lands at a higher latitude, same longitude', () => {
  const { lat, lon } = destinationPoint(50.0, 20.0, 0, 111.19); // ~1 degree of latitude
  assertClose(lat, 51.0, 0.01);
  assertClose(lon, 20.0, 0.01);
});

test('destinationPoint travelling due east on the equator lands at a higher longitude, same latitude', () => {
  const { lat, lon } = destinationPoint(0, 20.0, 90, 111.19);
  assertClose(lat, 0, 0.01);
  assertClose(lon, 21.0, 0.01);
});

test('destinationPoint with distance 0 returns the starting point unchanged', () => {
  const { lat, lon } = destinationPoint(50.0, 20.0, 137, 0);
  assertClose(lat, 50.0, 1e-9);
  assertClose(lon, 20.0, 1e-9);
});

test('destinationPoint is the inverse of distanceKm/bearingDegrees: travelling the computed bearing and distance from A to B lands back on B', () => {
  const a = { lat: 52.2297, lon: 21.0122 };
  const b = { lat: 51.5074, lon: -0.1278 };
  const bearing = bearingDegrees(a.lat, a.lon, b.lat, b.lon);
  const distance = distanceKm(a.lat, a.lon, b.lat, b.lon);
  const result = destinationPoint(a.lat, a.lon, bearing, distance);
  assertClose(result.lat, b.lat, 0.01);
  assertClose(result.lon, b.lon, 0.01);
});

test('destinationPoint normalizes longitude back into [-180, 180] when crossing the antimeridian', () => {
  const { lon } = destinationPoint(0, 179.5, 90, 200); // heading east from near +180
  assert.ok(lon >= -180 && lon <= 180, `expected ${lon} to be within [-180, 180]`);
  assertClose(lon, -178.7, 0.1);
});

test('isRangeEligible accepts every real adsb_-prefixed sourceType', () => {
  for (const sourceType of ['adsb_icao', 'adsb_icao_nt', 'adsb_other']) {
    assert.equal(isRangeEligible(sourceType), true, sourceType);
  }
});

test('isRangeEligible rejects MLAT and every other non-ADS-B sourceType', () => {
  for (const sourceType of ['mlat', 'mode_s', 'adsc', 'adsr_icao', 'adsr_other', 'tisb_icao', 'tisb_other', 'tisb_trackfile', 'other']) {
    assert.equal(isRangeEligible(sourceType), false, sourceType);
  }
});

test('isRangeEligible rejects a missing/undefined sourceType', () => {
  assert.equal(isRangeEligible(undefined), false);
  assert.equal(isRangeEligible(null), false);
});
