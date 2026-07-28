import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getListField, sortedFieldOptions } from './list-fields.js';

test('distance is null without a home location, formatted with a home location', () => {
  const field = getListField('distance');
  const aircraft = { lat: 51.0, lon: 20.0 };

  assert.equal(field.format(aircraft, 'imperial', {}), null);
  assert.equal(field.sortValue(aircraft, {}), null);

  const ctx = { home: { lat: 50.0, lon: 20.0 } };
  assert.match(field.format(aircraft, 'metric', ctx), /^\d+ km$/);
  assert.ok(typeof field.sortValue(aircraft, ctx) === 'number');
});

test('distance is null for an aircraft with no position, even with a home location', () => {
  const field = getListField('distance');
  const ctx = { home: { lat: 50.0, lon: 20.0 } };
  assert.equal(field.format({}, 'metric', ctx), null);
  assert.equal(field.sortValue({}, ctx), null);
});

test('boolean fields (e.g. military) format as raw true/false and sort as 1/0', () => {
  const field = getListField('military');
  assert.equal(field.boolean, true);
  assert.equal(field.format({ military: true }), true);
  assert.equal(field.format({ military: false }), false);
  assert.equal(field.sortValue({ military: true }), 1);
  assert.equal(field.sortValue({ military: false }), 0);
});

test('altBaro shows the ground marker and sorts below any real altitude, matching the details panel', () => {
  const field = getListField('altBaro');
  assert.equal(field.format({ onGround: true, altBaro: 0 }, 'imperial'), 'ground');
  assert.equal(field.sortValue({ onGround: true }), -1);
  assert.equal(field.sortValue({ altBaro: 5000 }), 5000);
});

test('enum-labeled fields (e.g. sourceType) fall back to the raw code when unmapped', () => {
  const field = getListField('sourceType');
  assert.equal(field.format({ sourceType: 'adsb_icao' }), 'ADS-B (ICAO)');
  assert.equal(field.format({ sourceType: 'some_future_code' }), 'some_future_code');
  assert.equal(field.format({}), null);
});

test('getListField returns null for an unknown key', () => {
  assert.equal(getListField('not-a-real-field'), null);
});

test('sortedFieldOptions covers every catalog entry exactly once, alphabetized by label', () => {
  const options = sortedFieldOptions();
  const keys = options.map((o) => o.key);
  assert.equal(new Set(keys).size, keys.length);
  assert.ok(keys.includes('distance'));
  assert.ok(keys.includes('military'));

  const labels = options.map((o) => o.label);
  const sorted = [...labels].sort((a, b) => a.localeCompare(b));
  assert.deepEqual(labels, sorted);
});
