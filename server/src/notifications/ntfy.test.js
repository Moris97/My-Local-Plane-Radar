import { test } from 'node:test';
import assert from 'node:assert/strict';

// baseClickUrl (server/src/notifications/ntfy.js's detectLocalUrl()) is
// computed once at module load from the real machine's network interfaces
// -- not mockable without reaching into os.networkInterfaces() before
// import, and genuinely environment-dependent (a sandboxed/containerized
// test runner may have no non-internal IPv4 interface at all, same as a
// real net-only receiver could). These tests only assert the *relationship*
// between the hex-less and hex-carrying click URLs, never a literal value.
const { sendNtfyNotification } = await import('./ntfy.js');

function fakeFetch(calls) {
  return async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return { ok: true };
  };
}

test('hex deep-links the click URL to ?select=<hex>; no hex leaves the plain root URL', async (t) => {
  const calls = [];
  t.mock.method(global, 'fetch', fakeFetch(calls));

  await sendNtfyNotification('test-topic', { title: 'A', message: 'a', hex: 'abc123' });
  await sendNtfyNotification('test-topic', { title: 'B', message: 'b' });

  const [withHex, withoutHex] = calls.map((c) => c.body);

  if (withoutHex.click) {
    // Only assertable when this environment actually resolved a LAN
    // address (baseClickUrl truthy) -- otherwise neither payload carries a
    // click field at all, which is the correct, pre-existing fallback.
    assert.equal(withHex.click, `${withoutHex.click}?select=abc123`);
    assert.ok(!withoutHex.click.includes('?select='));
  } else {
    assert.equal(withHex.click, undefined);
  }
});

test('a hex with characters needing escaping is percent-encoded in the click URL', async (t) => {
  const calls = [];
  t.mock.method(global, 'fetch', fakeFetch(calls));

  await sendNtfyNotification('test-topic', { title: 'A', message: 'a', hex: 'a&b c' });

  const [{ click }] = calls.map((c) => c.body);
  if (click) assert.ok(click.endsWith('?select=a%26b%20c'));
});
