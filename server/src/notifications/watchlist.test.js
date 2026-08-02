import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = mkdtempSync(join(tmpdir(), 'mlpr-watchlist-test-'));
process.env.MLPR_DB_PATH = join(tmpDir, 'test.db');

const watchlist = await import('./watchlist.js');

after(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  for (const entry of watchlist.getWatchList()) {
    watchlist.removeWatchEntry(entry.id);
  }
});

test('starts empty', () => {
  assert.deepEqual(watchlist.getWatchList(), []);
});

test('addWatchEntry assigns an id and stores the entry', () => {
  const entry = watchlist.addWatchEntry({ matchType: 'type', matchValue: 'B738' });
  assert.equal(typeof entry.id, 'string');
  assert.equal(entry.matchType, 'type');
  assert.equal(entry.matchValue, 'B738');
  assert.equal(entry.altitudeOperator, null);
  assert.deepEqual(watchlist.getWatchList(), [entry]);
});

test('matchValue is trimmed', () => {
  const entry = watchlist.addWatchEntry({ matchType: 'flight', matchValue: '  WZZ66  ' });
  assert.equal(entry.matchValue, 'WZZ66');
});

test('altitudeValue is dropped when no altitudeOperator is given', () => {
  const entry = watchlist.addWatchEntry({ matchType: 'type', matchValue: 'B738', altitudeValue: 5000 });
  assert.equal(entry.altitudeOperator, null);
  assert.equal(entry.altitudeValue, null);
});

test('removeWatchEntry removes only the matching id', () => {
  const a = watchlist.addWatchEntry({ matchType: 'type', matchValue: 'B738' });
  const b = watchlist.addWatchEntry({ matchType: 'type', matchValue: 'A320' });
  const removed = watchlist.removeWatchEntry(a.id);
  assert.equal(removed, true);
  assert.deepEqual(watchlist.getWatchList(), [b]);
});

test('removeWatchEntry returns false for an unknown id', () => {
  assert.equal(watchlist.removeWatchEntry('nope'), false);
});

test('validateWatchEntryInput rejects an unknown matchType', () => {
  assert.match(watchlist.validateWatchEntryInput({ matchType: 'bogus', matchValue: 'x' }), /matchType/);
});

test('validateWatchEntryInput rejects an empty matchValue', () => {
  assert.match(watchlist.validateWatchEntryInput({ matchType: 'type', matchValue: '   ' }), /matchValue/);
});

test('validateWatchEntryInput rejects an invalid altitudeOperator', () => {
  assert.match(
    watchlist.validateWatchEntryInput({ matchType: 'type', matchValue: 'B738', altitudeOperator: 'sideways' }),
    /altitudeOperator/,
  );
});

test('validateWatchEntryInput rejects a non-numeric altitudeValue when an operator is set', () => {
  assert.match(
    watchlist.validateWatchEntryInput({
      matchType: 'type',
      matchValue: 'B738',
      altitudeOperator: 'below',
      altitudeValue: 'low',
    }),
    /altitudeValue/,
  );
});

test('validateWatchEntryInput accepts a valid entry', () => {
  assert.equal(
    watchlist.validateWatchEntryInput({
      matchType: 'registration',
      matchValue: 'SP-TEST',
      altitudeOperator: 'above',
      altitudeValue: 10000,
    }),
    null,
  );
});

// Trigger area. Placeholder coordinates only -- never the real receiver
// location (see CLAUDE.md). The centre is an arbitrary point by design, not
// tied to home, so an area can cover e.g. a nearby airfield.
const VALID_CIRCLE = { kind: 'circle', lat: 50.0, lon: 20.0, radiusKm: 15 };

test('an entry with no area stores area: null', () => {
  const entry = watchlist.addWatchEntry({ matchType: 'type', matchValue: 'B738' });
  assert.equal(entry.area, null);
});

test('a circle area round-trips through storage', () => {
  const entry = watchlist.addWatchEntry({ matchType: 'type', matchValue: 'B738', area: { ...VALID_CIRCLE } });
  assert.deepEqual(entry.area, VALID_CIRCLE);
  assert.deepEqual(watchlist.getWatchList()[0].area, VALID_CIRCLE);
});

test('unrecognised area fields are stripped rather than stored verbatim', () => {
  const entry = watchlist.addWatchEntry({
    matchType: 'type',
    matchValue: 'B738',
    area: { ...VALID_CIRCLE, somethingElse: 'nope' },
  });
  assert.deepEqual(entry.area, VALID_CIRCLE);
});

test('validateArea accepts null/undefined (the area condition is optional)', () => {
  assert.equal(watchlist.validateArea(null), null);
  assert.equal(watchlist.validateArea(undefined), null);
});

test('validateArea rejects an unsupported shape', () => {
  // Deliberately a kind that will never exist, rather than "the next shape
  // we plan to add" -- this test had to be rewritten when 'rectangle'
  // shipped and again when 'polygon' did. What it's really guarding is that
  // an unknown kind is refused rather than stored as something rules.js
  // can't match.
  assert.match(watchlist.validateArea({ ...VALID_CIRCLE, kind: 'not-a-real-shape' }), /kind/);
});

test('validateArea rejects an out-of-range latitude/longitude', () => {
  assert.match(watchlist.validateArea({ ...VALID_CIRCLE, lat: 91 }), /lat/);
  assert.match(watchlist.validateArea({ ...VALID_CIRCLE, lon: -181 }), /lon/);
});

test('validateArea rejects a zero or negative radius', () => {
  assert.match(watchlist.validateArea({ ...VALID_CIRCLE, radiusKm: 0 }), /radiusKm/);
  assert.match(watchlist.validateArea({ ...VALID_CIRCLE, radiusKm: -5 }), /radiusKm/);
});

test('validateWatchEntryInput surfaces an invalid area', () => {
  assert.match(
    watchlist.validateWatchEntryInput({ matchType: 'type', matchValue: 'B738', area: { kind: 'circle' } }),
    /area\./,
  );
});

const VALID_RECTANGLE = { kind: 'rectangle', lat: 50.0, lon: 20.0, widthKm: 40, heightKm: 25 };

test('a rectangle area round-trips through storage', () => {
  const entry = watchlist.addWatchEntry({ matchType: 'type', matchValue: 'B738', area: { ...VALID_RECTANGLE } });
  assert.deepEqual(entry.area, VALID_RECTANGLE);
  assert.deepEqual(watchlist.getWatchList()[0].area, VALID_RECTANGLE);
});

test('validateArea requires both rectangle dimensions', () => {
  assert.match(watchlist.validateArea({ kind: 'rectangle', lat: 50.0, lon: 20.0, widthKm: 40 }), /heightKm/);
  assert.match(watchlist.validateArea({ kind: 'rectangle', lat: 50.0, lon: 20.0, heightKm: 25 }), /widthKm/);
  assert.match(watchlist.validateArea({ ...VALID_RECTANGLE, widthKm: 0 }), /widthKm/);
});

test("a rectangle does not pick up the circle's radiusKm, nor vice versa", () => {
  // Each shape stores only its own size fields -- a stray radiusKm on a
  // rectangle must not survive normalisation, or rules.js would have two
  // plausible-looking but conflicting sources of size.
  const rect = watchlist.addWatchEntry({
    matchType: 'type',
    matchValue: 'B738',
    area: { ...VALID_RECTANGLE, radiusKm: 99 },
  });
  assert.equal(rect.area.radiusKm, undefined);

  const circle = watchlist.addWatchEntry({
    matchType: 'type',
    matchValue: 'A320',
    area: { ...VALID_CIRCLE, widthKm: 99, heightKm: 99 },
  });
  assert.equal(circle.area.widthKm, undefined);
  assert.equal(circle.area.heightKm, undefined);
});

const VALID_POLYGON = {
  kind: 'polygon',
  lat: 50.5,
  lon: 20.5,
  points: [
    { lat: 50.0, lon: 20.0 },
    { lat: 51.0, lon: 20.0 },
    { lat: 51.0, lon: 21.0 },
  ],
};

test('a polygon area round-trips through storage', () => {
  const entry = watchlist.addWatchEntry({ matchType: 'type', matchValue: 'B738', area: { ...VALID_POLYGON } });
  assert.deepEqual(entry.area, VALID_POLYGON);
  assert.deepEqual(watchlist.getWatchList()[0].area, VALID_POLYGON);
});

test('validateArea requires at least three polygon points', () => {
  assert.match(watchlist.validateArea({ ...VALID_POLYGON, points: VALID_POLYGON.points.slice(0, 2) }), /at least 3/);
  assert.match(watchlist.validateArea({ ...VALID_POLYGON, points: [] }), /at least 3/);
  assert.match(watchlist.validateArea({ ...VALID_POLYGON, points: 'nope' }), /must be an array/);
});

test('validateArea caps the polygon point count', () => {
  // Bounded because this lands in the SQLite config table -- see the
  // POLYGON_MAX_POINTS comment in watchlist.js.
  const many = Array.from({ length: 61 }, (_, i) => ({ lat: 50 + i * 0.001, lon: 20 }));
  assert.match(watchlist.validateArea({ ...VALID_POLYGON, points: many }), /at most 60/);
});

test('validateArea rejects a malformed polygon vertex', () => {
  assert.match(watchlist.validateArea({ ...VALID_POLYGON, points: [...VALID_POLYGON.points, { lat: 91, lon: 20 }] }), /lat/);
  assert.match(watchlist.validateArea({ ...VALID_POLYGON, points: [...VALID_POLYGON.points, { lat: 50 }] }), /lon/);
  assert.match(watchlist.validateArea({ ...VALID_POLYGON, points: [...VALID_POLYGON.points, null] }), /must be an object/);
});

test('polygon vertices are stripped to lat/lon, like every other stored field', () => {
  const entry = watchlist.addWatchEntry({
    matchType: 'type',
    matchValue: 'B738',
    area: { ...VALID_POLYGON, points: VALID_POLYGON.points.map((p) => ({ ...p, note: 'smuggled' })) },
  });
  assert.deepEqual(entry.area.points, VALID_POLYGON.points);
});

test('a polygon does not pick up circle/rectangle size fields', () => {
  const entry = watchlist.addWatchEntry({
    matchType: 'type',
    matchValue: 'B738',
    area: { ...VALID_POLYGON, radiusKm: 99, widthKm: 99 },
  });
  assert.equal(entry.area.radiusKm, undefined);
  assert.equal(entry.area.widthKm, undefined);
});
