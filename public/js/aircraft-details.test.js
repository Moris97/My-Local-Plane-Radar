import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAircraftDetailTiles, GROUND_MARKER } from './aircraft-details.js';

function findTile(tiles, key) {
  return tiles.find((t) => t.key === key);
}

function findCluster(tiles, labelKey) {
  return tiles.find((t) => t.labelKey === labelKey);
}

test('core tiles only include fields that are actually present', () => {
  const { core } = buildAircraftDetailTiles({ hex: 'abc123', flight: 'WZZ66' });
  assert.equal(findTile(core, 'flight').value, 'WZZ66');
  assert.equal(findTile(core, 'registration'), undefined);
  assert.equal(findTile(core, 'typeCode'), undefined);
});

test('altitude shows the ground marker when onGround, ignoring altBaro', () => {
  const { core } = buildAircraftDetailTiles({ hex: 'abc', onGround: true, altBaro: 0 });
  assert.equal(findTile(core, 'altBaro').value, GROUND_MARKER);
});

test('altitude shows the rounded value in feet when airborne (imperial, the default)', () => {
  const { core } = buildAircraftDetailTiles({ hex: 'abc', altBaro: 5000.4 });
  assert.equal(findTile(core, 'altBaro').value, '5000 ft');
});

test('altitude converts to meters when units is "metric"', () => {
  const { core } = buildAircraftDetailTiles({ hex: 'abc', altBaro: 35000 }, 'metric');
  assert.equal(findTile(core, 'altBaro').value, '10668 m');
});

test('vertical rate is sign-prefixed, and zero is shown (not filtered out)', () => {
  const climbing = buildAircraftDetailTiles({ hex: 'abc', baroRate: 800 });
  assert.equal(findTile(climbing.core, 'baroRate').value, '+800 ft/min');

  const descending = buildAircraftDetailTiles({ hex: 'abc', baroRate: -650 });
  assert.equal(findTile(descending.core, 'baroRate').value, '-650 ft/min');

  const level = buildAircraftDetailTiles({ hex: 'abc', baroRate: 0 });
  assert.equal(findTile(level.core, 'baroRate').value, '0 ft/min');
});

test('vertical rate converts to m/s when units is "metric"', () => {
  const { core } = buildAircraftDetailTiles({ hex: 'abc', baroRate: 500 }, 'metric');
  assert.equal(findTile(core, 'baroRate').value, '+2.5 m/s');
});

test('speed cluster only includes the speed fields that are present', () => {
  const { core } = buildAircraftDetailTiles({ hex: 'abc', gs: 420, tas: 450.6 });
  const speedCluster = findCluster(core, 'detailSpeedGroup');
  assert.deepEqual(
    speedCluster.chips.map((c) => c.key),
    ['gs', 'tas'],
  );
  assert.equal(speedCluster.chips.find((c) => c.key === 'gs').value, '420 kt');
  assert.equal(speedCluster.chips.find((c) => c.key === 'tas').value, '451 kt');
});

test('speed cluster is entirely absent when no speed field has data', () => {
  const { core } = buildAircraftDetailTiles({ hex: 'abc' });
  assert.equal(findCluster(core, 'detailSpeedGroup'), undefined);
});

test('speed converts to km/h when units is "metric" (mach is unaffected -- dimensionless)', () => {
  const { core } = buildAircraftDetailTiles({ hex: 'abc', gs: 420, mach: 0.79 }, 'metric');
  const speedCluster = findCluster(core, 'detailSpeedGroup');
  assert.equal(speedCluster.chips.find((c) => c.key === 'gs').value, '778 km/h');
  assert.equal(speedCluster.chips.find((c) => c.key === 'mach').value, 0.79);
});

test('mach is rounded to two decimals', () => {
  const { core } = buildAircraftDetailTiles({ hex: 'abc', mach: 0.7834 });
  const speedCluster = findCluster(core, 'detailSpeedGroup');
  assert.equal(speedCluster.chips.find((c) => c.key === 'mach').value, 0.78);
});

test('category is mapped to a human label when known, falls back to the raw code otherwise', () => {
  const heavy = buildAircraftDetailTiles({ hex: 'abc', category: 'A5' });
  assert.equal(findTile(heavy.core, 'category').value, 'Heavy');

  const unknown = buildAircraftDetailTiles({ hex: 'abc', category: 'D3' });
  assert.equal(findTile(unknown.core, 'category').value, 'D3');
});

test('emergency is mapped to a readable phrase', () => {
  const { core } = buildAircraftDetailTiles({ hex: 'abc', emergency: 'downed' });
  assert.equal(findTile(core, 'emergency').value, 'Downed aircraft');
});

test('boolean flags only appear in extra tiles when true', () => {
  const withFlag = buildAircraftDetailTiles({ hex: 'abc', military: true, interesting: false });
  assert.notEqual(findTile(withFlag.extra, 'military'), undefined);
  assert.equal(findTile(withFlag.extra, 'interesting'), undefined);

  const withoutFlag = buildAircraftDetailTiles({ hex: 'abc', military: false });
  assert.equal(findTile(withoutFlag.extra, 'military'), undefined);
});

test('navModes is joined into a readable list using known labels', () => {
  const { extra } = buildAircraftDetailTiles({ hex: 'abc', navModes: ['autopilot', 'althold', 'weirdmode'] });
  assert.equal(findTile(extra, 'navModes').value, 'Autopilot, Altitude hold, weirdmode');
});

test('sourceType falls back to the raw string for an unmapped value', () => {
  const known = buildAircraftDetailTiles({ hex: 'abc', sourceType: 'mlat' });
  assert.equal(findTile(known.extra, 'sourceType').value, 'MLAT (multilateration)');

  const unknown = buildAircraftDetailTiles({ hex: 'abc', sourceType: 'something_new' });
  assert.equal(findTile(unknown.extra, 'sourceType').value, 'something_new');
});

test('quality cluster groups the low-priority fields together and skips absent ones', () => {
  const { extra } = buildAircraftDetailTiles({ hex: 'abc', nic: 8, gva: 2 });
  const qualityCluster = findCluster(extra, 'detailQualityGroup');
  assert.deepEqual(
    qualityCluster.chips.map((c) => c.key),
    ['nic', 'gva'],
  );
});

test('hex is always present and uppercased', () => {
  const { extra } = buildAircraftDetailTiles({ hex: 'a1b2c3' });
  assert.equal(findTile(extra, 'hex').value, 'A1B2C3');
});

test('flight and squawk share a pairId (both are plain broadcast fields, likely present together)', () => {
  const { core } = buildAircraftDetailTiles({ hex: 'abc', flight: 'WZZ66', squawk: '2451' });
  const flightTile = findTile(core, 'flight');
  const squawkTile = findTile(core, 'squawk');
  assert.equal(flightTile.pairId, squawkTile.pairId);
});

test('registration and typeCode share a pairId (both require --db-file, so they are correlated)', () => {
  const { core } = buildAircraftDetailTiles({ hex: 'abc', registration: 'SP-TEST', typeCode: 'B738' });
  const regTile = findTile(core, 'registration');
  const typeTile = findTile(core, 'typeCode');
  assert.equal(regTile.pairId, typeTile.pairId);
  assert.notEqual(regTile.pairId, findTile(core, 'flight')?.pairId);
});

test('an aircraft with almost no data still produces a valid (mostly empty) result', () => {
  const { core, extra } = buildAircraftDetailTiles({ hex: 'abc' });
  assert.equal(Array.isArray(core), true);
  assert.equal(Array.isArray(extra), true);
  assert.equal(findTile(extra, 'hex').value, 'ABC');
});
