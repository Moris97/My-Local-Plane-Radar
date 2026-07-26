import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAircraft } from './normalize.js';

test('returns null when hex is missing', () => {
  assert.equal(normalizeAircraft({ lat: 1, lon: 2 }), null);
});

test('returns null when hex is an empty string', () => {
  assert.equal(normalizeAircraft({ hex: '' }), null);
});

test('trims flight and drops it when blank', () => {
  const a = normalizeAircraft({ hex: 'abc', flight: 'ABC123  ' });
  assert.equal(a.flight, 'ABC123');

  const b = normalizeAircraft({ hex: 'abc', flight: '    ' });
  assert.equal(b.flight, undefined);
});

test('alt_baro "ground" sets onGround and clears altBaro, but altGeom is untouched', () => {
  const a = normalizeAircraft({ hex: 'abc', alt_baro: 'ground', alt_geom: 120 });
  assert.equal(a.onGround, true);
  assert.equal(a.altBaro, undefined);
  assert.equal(a.altGeom, 120);
});

test('numeric alt_baro is kept when not on the ground', () => {
  const a = normalizeAircraft({ hex: 'abc', alt_baro: 35000 });
  assert.equal(a.onGround, false);
  assert.equal(a.altBaro, 35000);
});

test('squawk must be a string, otherwise dropped', () => {
  const a = normalizeAircraft({ hex: 'abc', squawk: '7700' });
  assert.equal(a.squawk, '7700');

  const b = normalizeAircraft({ hex: 'abc', squawk: 7700 });
  assert.equal(b.squawk, undefined);
});

test('military flag reads bit 1 of dbFlags', () => {
  assert.equal(normalizeAircraft({ hex: 'abc', dbFlags: 1 }).military, true);
  assert.equal(normalizeAircraft({ hex: 'abc', dbFlags: 2 }).military, false);
  assert.equal(normalizeAircraft({ hex: 'abc' }).military, false);
});

test('registration, type code and description are trimmed', () => {
  const a = normalizeAircraft({ hex: 'abc', r: ' SP-TEST ', t: ' B738 ', desc: ' BOEING 737 ' });
  assert.equal(a.registration, 'SP-TEST');
  assert.equal(a.typeCode, 'B738');
  assert.equal(a.desc, 'BOEING 737');
});

test('missing optional fields become undefined rather than throwing', () => {
  const a = normalizeAircraft({ hex: 'abc' });
  assert.equal(a.lat, undefined);
  assert.equal(a.lon, undefined);
  assert.equal(a.track, undefined);
});
