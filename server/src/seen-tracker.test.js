import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSeenTracker } from './seen-tracker.js';

// Pure in-memory fake persistence -- createSeenTracker only ever calls
// getAllRows()/upsertRows(entries), so no real SQLite is needed to exercise
// its cache/dirty/flush logic in isolation.
function fakeStore(keyField) {
  const rows = new Map();
  return {
    keyField,
    getAllRows: () => Array.from(rows.values()),
    upsertRows: (entries) => {
      for (const entry of entries) {
        rows.set(entry[keyField], { [keyField]: entry[keyField], first_seen_at: entry.firstSeenAt, last_seen_at: entry.lastSeenAt });
      }
    },
    rows,
  };
}

test('has() is false for an unknown key and true right after create()', () => {
  const store = fakeStore('hex');
  const tracker = createSeenTracker(store);
  assert.equal(tracker.has('abc123'), false);
  tracker.create('abc123', 1000);
  assert.equal(tracker.has('abc123'), true);
});

test('create() is idempotent -- a second call does not reset firstSeenAt', () => {
  const store = fakeStore('hex');
  const tracker = createSeenTracker(store);
  tracker.create('abc123', 1000);
  tracker.create('abc123', 5000);
  tracker.flush();
  assert.equal(store.rows.get('abc123').first_seen_at, 1000);
});

test('touch() is a no-op for a key that was never created', () => {
  const store = fakeStore('hex');
  const tracker = createSeenTracker(store);
  tracker.touch('never-created', 1000);
  assert.equal(tracker.has('never-created'), false);
  assert.equal(tracker.flush(), 0);
});

test('touch() advances last_seen_at for an existing key without touching first_seen_at', () => {
  const store = fakeStore('hex');
  const tracker = createSeenTracker(store);
  tracker.create('abc123', 1000);
  tracker.touch('abc123', 9000);
  tracker.flush();
  const row = store.rows.get('abc123');
  assert.equal(row.first_seen_at, 1000);
  assert.equal(row.last_seen_at, 9000);
});

test('noteSeen() creates on first sight and advances last_seen_at on later sightings', () => {
  const store = fakeStore('flight');
  const tracker = createSeenTracker(store);
  tracker.noteSeen('RYR4521', 1000);
  tracker.noteSeen('RYR4521', 9000);
  tracker.flush();
  const row = store.rows.get('RYR4521');
  assert.equal(row.first_seen_at, 1000);
  assert.equal(row.last_seen_at, 9000);
});

test('flush() only writes dirty entries, and clears the dirty flag so a second flush is a no-op', () => {
  const store = fakeStore('hex');
  const tracker = createSeenTracker(store);
  tracker.create('abc123', 1000);
  assert.equal(tracker.flush(), 1);
  assert.equal(tracker.flush(), 0);
});

test('getCount(0) is the all-time distinct-key count; getCount(sinceMs) filters by last_seen_at', () => {
  const store = fakeStore('hex');
  const tracker = createSeenTracker(store);
  tracker.noteSeen('old', 1000);
  tracker.noteSeen('recent', 9000);
  assert.equal(tracker.getCount(0), 2);
  assert.equal(tracker.getCount(5000), 1);
});

test('reset() clears the cache, so state reloads fresh from getAllRows() on next access', () => {
  const store = fakeStore('hex');
  const tracker = createSeenTracker(store);
  tracker.create('abc123', 1000);
  tracker.flush();
  tracker.reset();
  // Nothing new to flush right after a reset -- the cache is empty until
  // the next access reloads it from the (unchanged) store.
  assert.equal(tracker.getCount(0), 1);
});
