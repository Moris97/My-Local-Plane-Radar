import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { colorForAltitude, recordPosition, clearHistory, trailFeaturesFor, filterMlatAnomalies, smoothMlatPositions } from './trail.js';

test('colorForAltitude is golden-green at ground level, pure green by 10,000 ft', () => {
  // 0-10,000 ft used to be a flat, identical green -- the band most
  // locally-tracked traffic actually spends its time in, so it's the one
  // that most needed a gradient. Ground level is now a distinct golden
  // green rather than a copy of the 10,000 ft color.
  assert.equal(colorForAltitude(0), 'rgb(210,196,30)');
  assert.equal(colorForAltitude(10000), 'rgb(61,220,132)');
  assert.notEqual(colorForAltitude(0), colorForAltitude(10000));
});

test('colorForAltitude is already clearly non-green partway through the green-to-blue band', () => {
  // Regression test: a straight RGB-channel lerp between these two stops
  // barely shifts the perceived color until near the very top of the
  // 10,000-17,500 ft band (green and blue share identical saturation/
  // lightness -- only hue differs -- so an RGB lerp doesn't sweep hue
  // evenly). At the midpoint the blue channel must have visibly risen from
  // pure green's 132.
  const [, , b] = colorForAltitude(13750).match(/rgb\((\d+),(\d+),(\d+)\)/).slice(1).map(Number);
  assert.ok(b > 132 + 20, `expected the blue channel to have risen well past pure green's 132 by the midpoint, got ${b}`);
});

test('colorForAltitude reaches exactly blue at 17,500 ft', () => {
  assert.equal(colorForAltitude(17500), 'rgb(61,140,220)');
});

test('colorForAltitude reaches exactly red at 30,250 ft', () => {
  assert.equal(colorForAltitude(30250), 'rgb(224,49,49)');
});

test('colorForAltitude reaches exactly dark red at 40,000 ft and beyond', () => {
  assert.equal(colorForAltitude(40000), 'rgb(107,15,15)');
  assert.equal(colorForAltitude(60000), 'rgb(107,15,15)');
});

function saturationOf(rgbString) {
  const [r, g, b] = rgbString.match(/\d+/g).map(Number).map((v) => v / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return 0;
  return l > 0.5 ? d / (2 - max - min) : d / (max + min);
}

test('no altitude produces a washed-out near-grey that could be mistaken for the no-contact colour', () => {
  // Regression test: the blue-to-dark-red leg used to be a plain RGB lerp,
  // which passes through desaturated mud -- at the old 35,000 ft stop
  // (typical cruise, so most trails) it produced rgb(92,57,83), a
  // grey-maroon barely distinguishable from the grey gap colour.
  for (let ft = 0; ft <= 40000; ft += 1000) {
    const saturation = saturationOf(colorForAltitude(ft));
    assert.ok(
      saturation > 0.35,
      `${ft} ft produced a washed-out colour (saturation ${(saturation * 100).toFixed(0)}%)`,
    );
  }
});

test('the no-contact grey stays clearly desaturated, unlike every altitude colour', () => {
  assert.ok(saturationOf('rgb(136,138,143)') < 0.1);
});

test('altitude changes of a few thousand feet are visibly different colours', () => {
  // "Distinguish an altitude change from a data gap" depends on adjacent
  // altitudes actually looking different -- with the old RGB lerp the whole
  // cruise band collapsed into near-identical mud.
  const distance = (a, b) => {
    const [r1, g1, b1] = a.match(/\d+/g).map(Number);
    const [r2, g2, b2] = b.match(/\d+/g).map(Number);
    return Math.hypot(r1 - r2, g1 - g2, b1 - b2);
  };

  for (let ft = 12000; ft + 3000 <= 40000; ft += 3000) {
    const delta = distance(colorForAltitude(ft), colorForAltitude(ft + 3000));
    assert.ok(delta > 30, `${ft} ft -> ${ft + 3000} ft barely changes colour (distance ${delta.toFixed(0)})`);
  }
});

test('colorForAltitude treats a missing/non-number altitude as ground level', () => {
  assert.equal(colorForAltitude(undefined), colorForAltitude(0));
  assert.equal(colorForAltitude('ground'), colorForAltitude(0));
});

const HEX = 'abc123';

beforeEach(() => {
  clearHistory(HEX);
});

function record(lng, alt, isGap = false) {
  recordPosition(HEX, [lng, 50], alt, Date.now(), isGap);
}

test('consecutive segments at a steady altitude merge into one polyline', () => {
  // Regression test for the "trail looks dashed when zoomed out" report:
  // every 2-point feature was a seam antialiasing could show as a hairline.
  for (let i = 0; i < 6; i += 1) record(20 + i * 0.01, 35000);

  const features = trailFeaturesFor(HEX);
  assert.equal(features.length, 1);
  assert.equal(features[0].geometry.coordinates.length, 6);
});

test('small altitude wobble within one band still merges (banding is what makes runs mergeable)', () => {
  for (const alt of [35000, 35040, 34980, 35010]) record(20, alt);

  assert.equal(trailFeaturesFor(HEX).length, 1);
});

test('a genuine altitude change starts a new run with its own color', () => {
  for (let i = 0; i < 3; i += 1) record(20 + i * 0.01, 5000);
  for (let i = 0; i < 3; i += 1) record(21 + i * 0.01, 30000);

  const features = trailFeaturesFor(HEX);
  assert.ok(features.length >= 2, `expected the climb to split the run, got ${features.length}`);
  assert.notEqual(features[0].properties.color, features[features.length - 1].properties.color);
});

test('a gap segment is its own feature, flagged and grey, and never merged into a colored run', () => {
  record(20.0, 35000);
  record(20.01, 35000);
  record(20.5, 35000, true); // reappeared after a loss of contact
  record(20.51, 35000);

  const features = trailFeaturesFor(HEX);
  const gaps = features.filter((f) => f.properties.isGap);

  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].geometry.coordinates.length, 2);
  assert.equal(gaps[0].properties.color, '#888a8f');
  // The colored runs on either side must not have swallowed it.
  assert.ok(features.every((f) => f.properties.isGap || f.properties.color !== '#888a8f'));
});

test('a missing altitude mid-trail carries the previous altitude forward instead of falling to ground/yellow', () => {
  // Regression test: a weak/fringe decode can drop the altitude subfield
  // while lat/lon still checksum, often right as an aircraft is about to
  // lose contact -- reported live as a solid golden-green "ground level"
  // segment appearing where the trail should have just kept its cruise
  // color (or gone dashed grey, if it was a real gap).
  record(20.0, 35000);
  record(20.01, 35000);
  record(20.02, undefined);
  record(20.03, undefined);

  const features = trailFeaturesFor(HEX);
  const groundColor = colorForAltitude(0);
  assert.ok(features.every((f) => f.properties.color !== groundColor));
  assert.equal(features.length, 1, 'should read as one continuous run, not a break to a different color');
});

test('a missing altitude with nothing earlier to carry forward still falls back to ground/yellow', () => {
  record(20.0, undefined);
  record(20.01, undefined);

  const features = trailFeaturesFor(HEX);
  assert.equal(features[0].properties.color, colorForAltitude(0));
});

test('a gap segment stays grey even when the reappearing point has no altitude to report', () => {
  record(20.0, 35000);
  record(20.01, 35000);
  record(20.5, undefined, true); // reappeared after a loss of contact, altitude not yet decoded again

  const features = trailFeaturesFor(HEX);
  const gaps = features.filter((f) => f.properties.isGap);
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].properties.color, '#888a8f');
});

test('every feature carries an explicit isGap boolean so the dashed layer filter can match on it', () => {
  record(20.0, 35000);
  record(20.01, 35000);

  for (const feature of trailFeaturesFor(HEX)) {
    assert.equal(typeof feature.properties.isGap, 'boolean');
  }
});

test('a single recorded position produces no segments at all', () => {
  record(20, 35000);
  assert.deepEqual(trailFeaturesFor(HEX), []);
});

test('filterMlatAnomalies never rejects ADS-B points, however implausible the jump', () => {
  const points = [
    { lngLat: [20, 50], t: 0, isGap: false, isMlat: false },
    { lngLat: [40, 60], t: 1000, isGap: false, isMlat: false }, // huge instant jump, but not MLAT
  ];
  assert.deepEqual(filterMlatAnomalies(points), points);
});

test('filterMlatAnomalies drops an MLAT point that would require unrealistic speed', () => {
  const base = { lngLat: [20, 50], t: 0, isGap: false, isMlat: false };
  const jump = { lngLat: [22, 50], t: 1000, isGap: false, isMlat: true }; // ~143 km in 1s
  assert.deepEqual(filterMlatAnomalies([base, jump]), [base]);
});

test('filterMlatAnomalies keeps an MLAT point with a realistic implied speed', () => {
  const base = { lngLat: [20, 50], t: 0, isGap: false, isMlat: false };
  const reasonable = { lngLat: [20.05, 50], t: 10000, isGap: false, isMlat: true }; // ~3.6 km over 10s, ~1284 km/h
  assert.deepEqual(filterMlatAnomalies([base, reasonable]), [base, reasonable]);
});

test('filterMlatAnomalies drops an MLAT point that implies an unrealistic turn rate, even at a plausible speed', () => {
  const p0 = { lngLat: [20, 50], t: 0, isGap: false, isMlat: false };
  const p1 = { lngLat: [20.1, 50], t: 60000, isGap: false, isMlat: false }; // heading east, ~430 km/h
  // Reverses to heading west 10s later -- ~1284 km/h alone (plausible speed),
  // but an 18deg/s turn (180deg swing in 10s), well past the turn-rate cap.
  const sharpTurn = { lngLat: [20.05, 50], t: 70000, isGap: false, isMlat: true };
  assert.deepEqual(filterMlatAnomalies([p0, p1, sharpTurn]), [p0, p1]);
});

test('filterMlatAnomalies does not flag a "turn" from tiny, noise-scale movements', () => {
  const p0 = { lngLat: [20, 50], t: 0, isGap: false, isMlat: false };
  const p1 = { lngLat: [20.001, 50], t: 60000, isGap: false, isMlat: false }; // ~71 m -- below the turn-check distance floor
  const jitter = { lngLat: [19.999, 50], t: 61000, isGap: false, isMlat: true }; // reverses direction, but also tiny
  assert.deepEqual(filterMlatAnomalies([p0, p1, jitter]), [p0, p1, jitter]);
});

test('a rejected MLAT point is not used as the reference point for judging the next one', () => {
  const p0 = { lngLat: [20, 50], t: 0, isGap: false, isMlat: false };
  const badJump = { lngLat: [25, 50], t: 1000, isGap: false, isMlat: true }; // rejected -- huge jump from p0
  // Reasonable relative to p0 (the last *accepted* point), wildly
  // unreasonable relative to badJump -- must be judged against p0.
  const backToNormal = { lngLat: [20.05, 50], t: 11000, isGap: false, isMlat: true };
  assert.deepEqual(filterMlatAnomalies([p0, badJump, backToNormal]), [p0, backToNormal]);
});

test('smoothMlatPositions blends an interior MLAT point 25/50/25 with its neighbors', () => {
  const points = [
    { lngLat: [20, 50], t: 0, isGap: false, isMlat: false },
    { lngLat: [20.1, 50], t: 1000, isGap: false, isMlat: true },
    { lngLat: [20, 50], t: 2000, isGap: false, isMlat: false },
  ];
  const [, smoothed] = smoothMlatPositions(points);
  assert.equal(smoothed.lngLat[0], 20.05); // (20 + 2*20.1 + 20) / 4
  assert.equal(smoothed.lngLat[1], 50);
});

test('smoothMlatPositions never modifies ADS-B or gap points', () => {
  const points = [
    { lngLat: [20, 50], t: 0, isGap: false, isMlat: false },
    { lngLat: [20.1, 50], t: 1000, isGap: false, isMlat: false },
    { lngLat: [20.2, 50], t: 2000, isGap: true, isMlat: false },
  ];
  assert.deepEqual(smoothMlatPositions(points), points);
});

test('smoothMlatPositions leaves an MLAT point with only one real neighbor (trail start/end) unchanged', () => {
  const points = [
    { lngLat: [20, 50], t: 0, isGap: false, isMlat: true },
    { lngLat: [20.1, 50], t: 1000, isGap: false, isMlat: false },
  ];
  assert.deepEqual(smoothMlatPositions(points), points);
});

test('smoothMlatPositions does not blend an MLAT point across a gap', () => {
  const points = [
    { lngLat: [20, 50], t: 0, isGap: true, isMlat: false },
    { lngLat: [20.1, 50], t: 1000, isGap: false, isMlat: true },
    { lngLat: [20.2, 50], t: 2000, isGap: false, isMlat: false },
  ];
  assert.deepEqual(smoothMlatPositions(points), points);
});

test('trailFeaturesFor drops an anomalous MLAT jump end-to-end', () => {
  recordPosition(HEX, [20, 50], 5000, 0, false, 'adsb_icao');
  recordPosition(HEX, [25, 50], 5000, 1000, false, 'mlat'); // huge jump, MLAT
  recordPosition(HEX, [20.01, 50], 5000, 11000, false, 'adsb_icao');

  const features = trailFeaturesFor(HEX);
  const allLngs = features.flatMap((f) => f.geometry.coordinates).map(([lng]) => lng);
  assert.ok(!allLngs.includes(25), `the anomalous MLAT jump to lng=25 should have been dropped, got lngs ${allLngs}`);
});

test('trailFeaturesFor never drops or moves an ADS-B point, whatever its neighbors look like', () => {
  recordPosition(HEX, [20, 50], 5000, 0, false, 'mlat');
  recordPosition(HEX, [40, 60], 5000, 1000, false, 'adsb_icao'); // implausible jump, but real ADS-B
  recordPosition(HEX, [20.01, 50], 5000, 2000, false, 'mlat');

  const features = trailFeaturesFor(HEX);
  const allCoords = features.flatMap((f) => f.geometry.coordinates);
  assert.ok(allCoords.some(([lng, lat]) => lng === 40 && lat === 60), 'the ADS-B point at [40, 60] must survive untouched');
});
