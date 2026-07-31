import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { HttpSource } from './HttpSource.js';

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

test('fetchSnapshot returns the parsed JSON on a normal response', async () => {
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ aircraft: [] }) });
  const source = new HttpSource('http://example.test/data/aircraft.json');
  assert.deepEqual(await source.fetchSnapshot(), { aircraft: [] });
});

test('fetchSnapshot returns null (not a thrown error) on a non-ok response', async () => {
  global.fetch = async () => ({ ok: false, status: 500 });
  const source = new HttpSource('http://example.test/data/aircraft.json');
  assert.equal(await source.fetchSnapshot(), null);
});

test('fetchSnapshot passes an AbortSignal to fetch', async () => {
  let receivedSignal;
  global.fetch = async (url, options) => {
    receivedSignal = options?.signal;
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const source = new HttpSource('http://example.test/data/aircraft.json');
  await source.fetchSnapshot();
  assert.ok(receivedSignal instanceof AbortSignal);
});

// The real-world bug this guards against: a stalled connection with no
// timeout hangs forever, and since pollOnce() runs on a plain setInterval
// that never waits for the previous call, a hung fetch() piles up a new
// one every second rather than just delaying one tick. A short timeoutMs
// here (instead of waiting out the real DEFAULT_TIMEOUT_MS) is what keeps
// this test itself fast.
//
// The mock below rejects when its `signal` aborts -- mirroring what real
// fetch() actually does with an AbortSignal -- since a mock that just
// returns a Promise that never settles wouldn't exercise the timeout at
// all: nothing would ever be listening on the signal to reject it, so the
// call would hang for real regardless of how short timeoutMs is (a
// mistake this test itself started with).
test('fetchSnapshot gives up and returns null if the connection stalls past its timeout', async () => {
  global.fetch = (url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(options.signal.reason));
  });
  const source = new HttpSource('http://example.test/data/aircraft.json', { timeoutMs: 30 });
  const result = await source.fetchSnapshot();
  assert.equal(result, null);
});

test('fetchReceiverInfo and fetchStats resolve sibling paths next to the configured aircraft.json URL', async () => {
  const requestedUrls = [];
  global.fetch = async (url) => {
    requestedUrls.push(String(url));
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const source = new HttpSource('http://example.test/data/aircraft.json');
  await source.fetchReceiverInfo();
  await source.fetchStats();
  assert.equal(requestedUrls[0], 'http://example.test/data/receiver.json');
  assert.equal(requestedUrls[1], 'http://example.test/data/stats.json');
});
