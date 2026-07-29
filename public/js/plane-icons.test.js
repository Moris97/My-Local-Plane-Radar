import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PLANE_ICON_IDS, NON_ROTATING_ICON_IDS } from './plane-icons.js';

// balloon/tower/drone have no meaningful "nose direction" to rotate toward
// (an upside-down balloon puts the basket on top -- caught live 2026-07-29).
// Regression guard for exactly that: every entry here must be a real icon
// id, and the set must not silently grow or shrink.
test('NON_ROTATING_ICON_IDS is exactly balloon, drone, tower', () => {
  assert.deepEqual([...NON_ROTATING_ICON_IDS].sort(), ['balloon', 'drone', 'tower']);
  for (const id of NON_ROTATING_ICON_IDS) {
    assert.ok(PLANE_ICON_IDS.includes(id), `${id} should be a real icon id`);
  }
});
