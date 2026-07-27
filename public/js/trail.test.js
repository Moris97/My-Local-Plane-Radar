import { test } from 'node:test';
import assert from 'node:assert/strict';
import { colorForAltitude } from './trail.js';

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

test('colorForAltitude treats a missing/non-number altitude as ground level (pure green)', () => {
  assert.equal(colorForAltitude(undefined), 'rgb(61,220,132)');
  assert.equal(colorForAltitude('ground'), 'rgb(61,220,132)');
});
