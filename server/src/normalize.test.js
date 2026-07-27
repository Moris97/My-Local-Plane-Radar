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

test('interesting/pia/ladd flags read their respective dbFlags bits', () => {
  const a = normalizeAircraft({ hex: 'abc', dbFlags: 2 });
  assert.equal(a.interesting, true);
  assert.equal(a.pia, false);
  assert.equal(a.ladd, false);

  const b = normalizeAircraft({ hex: 'abc', dbFlags: 4 | 8 });
  assert.equal(b.interesting, false);
  assert.equal(b.pia, true);
  assert.equal(b.ladd, true);
});

test('speed/nav fields pass through as numbers, missing ones stay undefined', () => {
  const a = normalizeAircraft({ hex: 'abc', ias: 280, tas: 310, mach: 0.78, nav_altitude_mcp: 36000 });
  assert.equal(a.ias, 280);
  assert.equal(a.tas, 310);
  assert.equal(a.mach, 0.78);
  assert.equal(a.navAltitudeMcp, 36000);
  assert.equal(a.navAltitudeFms, undefined);
});

test('nav_modes is passed through only when it is an array of strings', () => {
  const a = normalizeAircraft({ hex: 'abc', nav_modes: ['autopilot', 'althold'] });
  assert.deepEqual(a.navModes, ['autopilot', 'althold']);

  const b = normalizeAircraft({ hex: 'abc', nav_modes: 'autopilot' });
  assert.equal(b.navModes, undefined);
});

test('alert and spi are read as booleans from 0/1, undefined when absent', () => {
  const a = normalizeAircraft({ hex: 'abc', alert: 1, spi: 0 });
  assert.equal(a.alert, true);
  assert.equal(a.spi, false);

  const b = normalizeAircraft({ hex: 'abc' });
  assert.equal(b.alert, undefined);
  assert.equal(b.spi, undefined);
});

test('emergency "none" is treated the same as absent; a real value passes through', () => {
  const a = normalizeAircraft({ hex: 'abc', emergency: 'none' });
  assert.equal(a.emergency, undefined);

  const b = normalizeAircraft({ hex: 'abc', emergency: 'downed' });
  assert.equal(b.emergency, 'downed');
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
