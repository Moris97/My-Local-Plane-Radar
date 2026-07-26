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
