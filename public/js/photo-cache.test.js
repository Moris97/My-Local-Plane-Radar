import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getCachedPhoto, setCachedPhoto } from './photo-cache.js';

function fakeStorage() {
  const store = new Map();
  return {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, value),
  };
}

test('an unfetched hex reports not cached', () => {
  const storage = fakeStorage();
  assert.deepEqual(getCachedPhoto('abc123', storage), { cached: false });
});

test('a cached hit is returned as-is', () => {
  const storage = fakeStorage();
  const photo = { src: 'https://example.com/a.jpg', link: 'https://example.com', photographer: 'Someone' };
  setCachedPhoto('abc123', photo, storage);
  assert.deepEqual(getCachedPhoto('abc123', storage), { cached: true, photo });
});

test('a fresh cached miss is returned without a photo, still counted as cached', () => {
  const storage = fakeStorage();
  const now = Date.now();
  setCachedPhoto('abc123', null, storage, now);
  assert.deepEqual(getCachedPhoto('abc123', storage, now + 1000), { cached: true, photo: null });
});

test('a cached miss past its TTL is reported as not cached, so it can be retried', () => {
  const storage = fakeStorage();
  const now = Date.now();
  setCachedPhoto('abc123', null, storage, now);
  const eightDaysLater = now + 8 * 24 * 60 * 60 * 1000;
  assert.deepEqual(getCachedPhoto('abc123', storage, eightDaysLater), { cached: false });
});

test('a cached hit does not expire, even long after a miss TTL would have', () => {
  const storage = fakeStorage();
  const now = Date.now();
  const photo = { src: 'https://example.com/a.jpg', link: 'https://example.com', photographer: 'Someone' };
  setCachedPhoto('abc123', photo, storage, now);
  const oneYearLater = now + 365 * 24 * 60 * 60 * 1000;
  assert.deepEqual(getCachedPhoto('abc123', storage, oneYearLater), { cached: true, photo });
});

test('different hexes are cached independently', () => {
  const storage = fakeStorage();
  setCachedPhoto('aaa111', { src: 'a' }, storage);
  setCachedPhoto('bbb222', null, storage);
  assert.deepEqual(getCachedPhoto('aaa111', storage), { cached: true, photo: { src: 'a' } });
  assert.deepEqual(getCachedPhoto('bbb222', storage), { cached: true, photo: null });
  assert.deepEqual(getCachedPhoto('ccc333', storage), { cached: false });
});

test('the cache is trimmed back down once it exceeds the entry cap, evicting the oldest entries first', () => {
  const storage = fakeStorage();
  const now = Date.now();
  for (let i = 0; i < 3001; i++) {
    setCachedPhoto(`hex${i}`, null, storage, now + i);
  }
  const raw = JSON.parse(storage.getItem('mlpr-photo-cache'));
  const remaining = Object.keys(raw).length;
  assert.ok(remaining <= 2500, `expected the cache to be trimmed to <=2500 entries, got ${remaining}`);
  // The oldest entries (hex0, hex1, ...) should be the ones evicted.
  assert.equal(raw.hex0, undefined);
  assert.ok(raw.hex3000, 'the most recently written entry should survive eviction');
});
