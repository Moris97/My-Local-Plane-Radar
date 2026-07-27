import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { colorForAltitude, recordPosition, clearHistory, trailFeaturesFor } from './trail.js';

test('colorForAltitude is pure green at and below 10,000 ft', () => {
  assert.equal(colorForAltitude(0), 'rgb(61,220,132)');
  assert.equal(colorForAltitude(5000), 'rgb(61,220,132)');
  assert.equal(colorForAltitude(10000), 'rgb(61,220,132)');
});

test('colorForAltitude is already clearly non-green partway through the green-to-blue band', () => {
  // Regression test: a straight RGB-channel lerp between these two stops
  // barely shifts the perceived color until near the very top of the
  // 10,000-25,000 ft band (green and blue share identical saturation/
  // lightness -- only hue differs -- so an RGB lerp doesn't sweep hue
  // evenly). Reported live: a plane at ~4,900 m (16,000 ft) still looked
  // pure green. At the midpoint the green channel must have visibly
  // dropped from its full 220 value.
  const [, , b] = colorForAltitude(17500).match(/rgb\((\d+),(\d+),(\d+)\)/).slice(1).map(Number);
  assert.ok(b > 132 + 40, `expected the blue channel to have risen well past pure green's 132 by the midpoint, got ${b}`);
});

test('colorForAltitude reaches exactly blue at 25,000 ft', () => {
  assert.equal(colorForAltitude(25000), 'rgb(61,140,220)');
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
  // Regression test: the 25,000-40,000 ft leg used to be a plain RGB lerp
  // from blue to dark red, which passes through desaturated mud -- at
  // 35,000 ft (typical cruise, so most trails) it produced rgb(92,57,83),
  // a grey-maroon barely distinguishable from the grey gap colour.
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

  for (let ft = 12000; ft < 40000; ft += 3000) {
    const delta = distance(colorForAltitude(ft), colorForAltitude(ft + 3000));
    assert.ok(delta > 30, `${ft} ft -> ${ft + 3000} ft barely changes colour (distance ${delta.toFixed(0)})`);
  }
});

test('colorForAltitude treats a missing/non-number altitude as ground level (pure green)', () => {
  assert.equal(colorForAltitude(undefined), 'rgb(61,220,132)');
  assert.equal(colorForAltitude('ground'), 'rgb(61,220,132)');
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
