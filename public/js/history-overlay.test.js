import test from 'node:test';
import assert from 'node:assert/strict';

// The module reads the global `history` at call time, so a stub installed
// before importing it is enough -- no DOM, no browser.
const calls = [];
globalThis.history = {
  pushState: (...args) => calls.push(['pushState', ...args]),
  back: () => calls.push(['back']),
};

const { openHistoryOverlay, handleOverlayPop } = await import('./history-overlay.js');

test('an overlay claims the back gesture, once', () => {
  calls.length = 0;
  let popped = 0;
  openHistoryOverlay(() => { popped += 1; });

  assert.equal(calls[0][0], 'pushState');
  assert.equal(handleOverlayPop(), true);
  assert.equal(popped, 1);
  // Nothing is registered any more, so a second back belongs to whatever is
  // underneath (panels.js's own panel/modal entry).
  assert.equal(handleOverlayPop(), false);
  assert.equal(popped, 1);
});

test('closing by any other route consumes its own entry, and that pop is swallowed', () => {
  calls.length = 0;
  let popped = 0;
  const release = openHistoryOverlay(() => { popped += 1; });

  release();
  assert.deepEqual(calls.at(-1), ['back']);
  // The popstate history.back() causes must not fall through to panels.js,
  // which would close the panel the overlay was opened from.
  assert.equal(handleOverlayPop(), true);
  assert.equal(popped, 0);
  assert.equal(handleOverlayPop(), false);
});

test('release after a real back gesture is a no-op', () => {
  calls.length = 0;
  const release = openHistoryOverlay(() => {});

  handleOverlayPop();
  calls.length = 0;
  release();
  // No second history.back(): the entry is already gone, and popping one
  // more would take the browser off the page.
  assert.deepEqual(calls, []);
  assert.equal(handleOverlayPop(), false);
});
