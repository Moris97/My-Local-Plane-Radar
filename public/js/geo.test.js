import { test } from 'node:test';
import assert from 'node:assert/strict';
import { distanceKm, bearingDegrees, findNearestFarthest, destinationPoint, circleRing, rectangleRing, rectangleEdges, polygonRing, polygonCentroid, regularPolygonPoints } from './geo.js';

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

// Placeholder coordinates only -- never the real receiver location.
const ORIGIN = { lat: 50.0, lon: 20.0 };

test('destinationPoint round-trips against distanceKm/bearingDegrees', () => {
  const point = destinationPoint(ORIGIN.lat, ORIGIN.lon, 42, 137);
  assertClose(distanceKm(ORIGIN.lat, ORIGIN.lon, point.lat, point.lon), 137, 0.5);
  assertClose(bearingDegrees(ORIGIN.lat, ORIGIN.lon, point.lat, point.lon), 42, 0.5);
});

test('destinationPoint due north only changes latitude', () => {
  const point = destinationPoint(ORIGIN.lat, ORIGIN.lon, 0, 111);
  assertClose(point.lon, ORIGIN.lon, 0.001);
  assert.ok(point.lat > ORIGIN.lat);
});

test('circleRing returns a closed ring whose points are all the given radius away', () => {
  const radiusKm = 25;
  const ring = circleRing(ORIGIN.lat, ORIGIN.lon, radiusKm, 32);

  // steps + 1: the first point is repeated to close the ring.
  assert.equal(ring.length, 33);
  assert.deepEqual(ring[0], ring[ring.length - 1]);

  for (const [lon, lat] of ring) {
    assertClose(distanceKm(ORIGIN.lat, ORIGIN.lon, lat, lon), radiusKm, 0.1);
  }
});

test('circleRing covers the full compass, not just one side', () => {
  const ring = circleRing(ORIGIN.lat, ORIGIN.lon, 25, 4);
  const bearings = ring.slice(0, 4).map(([lon, lat]) => Math.round(bearingDegrees(ORIGIN.lat, ORIGIN.lon, lat, lon)));
  assert.deepEqual(bearings.sort((a, b) => a - b), [0, 90, 180, 270]);
});

test('rectangleEdges puts each edge half the given dimension from the centre', () => {
  const { north, south, east, west } = rectangleEdges(ORIGIN.lat, ORIGIN.lon, 40, 20);

  // Height 20 km -> 10 km to each of the north/south edges.
  assertClose(distanceKm(ORIGIN.lat, ORIGIN.lon, north, ORIGIN.lon), 10, 0.1);
  assertClose(distanceKm(ORIGIN.lat, ORIGIN.lon, south, ORIGIN.lon), 10, 0.1);
  // Width 40 km -> 20 km to each of the east/west edges.
  assertClose(distanceKm(ORIGIN.lat, ORIGIN.lon, ORIGIN.lat, east), 20, 0.1);
  assertClose(distanceKm(ORIGIN.lat, ORIGIN.lon, ORIGIN.lat, west), 20, 0.1);

  assert.ok(north > south, 'north edge must be above the south edge');
  assert.ok(east > west, 'east edge must be right of the west edge');
});

test('rectangleRing is a closed 4-corner ring', () => {
  const ring = rectangleRing(ORIGIN.lat, ORIGIN.lon, 40, 20);
  assert.equal(ring.length, 5); // 4 corners + the repeated first point
  assert.deepEqual(ring[0], ring[4]);

  // Opposite corners must differ on both axes -- catches a degenerate ring
  // collapsed onto one edge.
  const [swLon, swLat] = ring[3];
  const [neLon, neLat] = ring[1];
  assert.ok(neLat > swLat && neLon > swLon);
});

test('a wider rectangle grows only on its own axis', () => {
  const narrow = rectangleEdges(ORIGIN.lat, ORIGIN.lon, 40, 20);
  const wide = rectangleEdges(ORIGIN.lat, ORIGIN.lon, 80, 20);

  assert.ok(wide.east > narrow.east, 'doubling width must move the east edge out');
  // Height was unchanged, so the horizontal edges must not have moved.
  assertClose(wide.north, narrow.north, 1e-9);
  assertClose(wide.south, narrow.south, 1e-9);
});

test('polygonRing closes the ring and keeps vertex order', () => {
  const points = [
    { lat: 50.0, lon: 20.0 },
    { lat: 51.0, lon: 20.0 },
    { lat: 51.0, lon: 21.0 },
  ];
  const ring = polygonRing(points);
  assert.equal(ring.length, 4); // 3 vertices + the repeated first
  assert.deepEqual(ring[0], [20.0, 50.0]); // [lon, lat], GeoJSON order
  assert.deepEqual(ring[0], ring[3]);
  assert.deepEqual(ring[2], [21.0, 51.0]);
});

test('polygonCentroid averages the vertices', () => {
  const centre = polygonCentroid([
    { lat: 50.0, lon: 20.0 },
    { lat: 52.0, lon: 20.0 },
    { lat: 52.0, lon: 22.0 },
    { lat: 50.0, lon: 22.0 },
  ]);
  assertClose(centre.lat, 51.0, 1e-9);
  assertClose(centre.lon, 21.0, 1e-9);
});

test('regularPolygonPoints builds an n-gon with every vertex the same distance out', () => {
  const points = regularPolygonPoints(ORIGIN.lat, ORIGIN.lon, 40, 6);
  assert.equal(points.length, 6);
  for (const point of points) {
    assertClose(distanceKm(ORIGIN.lat, ORIGIN.lon, point.lat, point.lon), 40, 0.1);
  }
  // First vertex due north, so there's a predictable one to grab first.
  assertClose(points[0].lon, ORIGIN.lon, 1e-6);
  assert.ok(points[0].lat > ORIGIN.lat);
});

test('a regular polygon centroid lands back on the centre it was built around', () => {
  const points = regularPolygonPoints(ORIGIN.lat, ORIGIN.lon, 40, 6);
  const centre = polygonCentroid(points);
  assertClose(centre.lat, ORIGIN.lat, 0.01);
  assertClose(centre.lon, ORIGIN.lon, 0.01);
});
