import { test } from 'node:test';
import assert from 'node:assert/strict';

// settings-state.js reads localStorage at module scope, but load() already
// swallows the failure and falls back to the defaults -- so under plain
// node --test this module initialises cleanly with exactly the default
// settings, which is what these tests exercise. applyLocalBackup is not
// covered here because it writes through save(), i.e. needs a real
// localStorage; its filtering (the part with actual logic) is
// filterKnownSettings below.
import { filterKnownSettings, collectLocalBackup, ICON_SIZE_DEFAULT } from './settings-state.js';

test('known keys pass through unchanged', () => {
  const out = filterKnownSettings({
    units: 'metric',
    aircraftIconSize: 52,
    listPositionFirst: false,
    listColumns: ['flight', 'hex'],
    aircraftLabelFields: { flight: false, type: true },
  });

  assert.deepEqual(out, {
    units: 'metric',
    aircraftIconSize: 52,
    listPositionFirst: false,
    listColumns: ['flight', 'hex'],
    aircraftLabelFields: { flight: false, type: true },
  });
});

test('unknown keys are dropped rather than carried around forever', () => {
  // load() spreads whatever is stored over the defaults, so anything that
  // gets in here would survive every future save until localStorage is
  // cleared by hand.
  const out = filterKnownSettings({ units: 'metric', somethingFromAnotherApp: true, evil: { a: 1 } });
  assert.deepEqual(out, { units: 'metric' });
});

test('a value whose type does not match the default is dropped', () => {
  const out = filterKnownSettings({
    aircraftIconSize: 'huge', // number expected
    units: 42, // string expected
    showCoverage: 'yes', // boolean expected
    listColumns: 'flight', // array expected
    aircraftLabelFields: ['flight'], // object expected, not an array
  });
  assert.deepEqual(out, {});
});

test('the nullable altitude filter accepts null and finite numbers, nothing else', () => {
  assert.deepEqual(filterKnownSettings({ altitudeFilterMin: null }), { altitudeFilterMin: null });
  assert.deepEqual(filterKnownSettings({ altitudeFilterMax: 30000 }), { altitudeFilterMax: 30000 });
  assert.deepEqual(filterKnownSettings({ altitudeFilterMin: 'low' }), {});
  assert.deepEqual(filterKnownSettings({ altitudeFilterMin: Infinity }), {});
});

test('null is refused for a key whose default is not null', () => {
  // Otherwise a null would replace e.g. listColumns and break the List.
  assert.deepEqual(filterKnownSettings({ listColumns: null, units: null }), {});
});

test('__proto__ and non-object input are handled defensively', () => {
  assert.deepEqual(filterKnownSettings(JSON.parse('{"__proto__": {"units": "metric"}}')), {});
  assert.deepEqual(filterKnownSettings(null), {});
  assert.deepEqual(filterKnownSettings('nope'), {});
  assert.deepEqual(filterKnownSettings(['units']), {});
  assert.equal({}.units, undefined, 'Object.prototype must be untouched');
});

test('a structurally broken list config is rejected, not just a wrong-typed one', () => {
  // The whole point of the filter: these all pass a naive typeof/isArray
  // check, get persisted, and then throw on every redraw in list.js's sort
  // comparator or render a column-less table -- broken across reloads until
  // localStorage is cleared by hand.
  assert.deepEqual(filterKnownSettings({ listSortLevels: [null] }), {});
  assert.deepEqual(filterKnownSettings({ listSortLevels: [{ key: 'flight' }] }), {}, 'asc must be present');
  assert.deepEqual(filterKnownSettings({ listSortLevels: [{ key: 42, asc: true }] }), {});
  assert.deepEqual(filterKnownSettings({ listSortLevels: [] }), {}, 'sorting by nothing is not a state the UI allows');
  assert.deepEqual(filterKnownSettings({ listColumns: [] }), {}, 'a column-less table is not a state the UI allows');
  assert.deepEqual(filterKnownSettings({ listColumns: ['flight', 7] }), {});
  assert.deepEqual(filterKnownSettings({ aircraftLabelFields: { flight: 'yes' } }), {});
  assert.deepEqual(filterKnownSettings({ aircraftLabelFields: null }), {}, "typeof null is 'object' too");

  // And the good versions still pass.
  assert.deepEqual(filterKnownSettings({ listSortLevels: [{ key: 'gs', asc: false }] }), {
    listSortLevels: [{ key: 'gs', asc: false }],
  });
});

test('out-of-range numbers and unknown enum values are rejected', () => {
  assert.deepEqual(filterKnownSettings({ aircraftIconSize: 1e9 }), {});
  assert.deepEqual(filterKnownSettings({ aircraftIconSize: 0 }), {});
  assert.deepEqual(filterKnownSettings({ aircraftIconSize: NaN }), {});
  assert.deepEqual(filterKnownSettings({ sidePanelWidth: -5 }), {});
  assert.deepEqual(filterKnownSettings({ basemapMode: 'bogus' }), {});
  assert.deepEqual(filterKnownSettings({ mapTheme: 'neon' }), {});
  assert.deepEqual(filterKnownSettings({ units: 'furlongs' }), {});
  assert.deepEqual(filterKnownSettings({ coverageBand: 42 }), {});

  assert.deepEqual(filterKnownSettings({ aircraftIconSize: 52 }), { aircraftIconSize: 52 });
  assert.deepEqual(filterKnownSettings({ coverageBand: 'stacked' }), { coverageBand: 'stacked' });
  assert.deepEqual(filterKnownSettings({ coverageBand: 3 }), { coverageBand: 3 });
});

test('collectLocalBackup snapshots the settings and only adds statsRange when given one', () => {
  const withoutRange = collectLocalBackup();
  assert.equal(withoutRange.settings.aircraftIconSize, ICON_SIZE_DEFAULT);
  assert.equal('statsRange' in withoutRange, false);

  assert.equal(collectLocalBackup('7d').statsRange, '7d');
  assert.equal('statsRange' in collectLocalBackup(42), false);
});
