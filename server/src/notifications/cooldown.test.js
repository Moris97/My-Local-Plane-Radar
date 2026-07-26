import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { isOnCooldown, markNotified, pruneCooldowns, resetCooldowns } from './cooldown.js';

beforeEach(() => {
  resetCooldowns();
});

test('not on cooldown before any notification', () => {
  assert.equal(isOnCooldown('squawk', 'abc'), false);
});

test('on cooldown immediately after marking', () => {
  markNotified('squawk', 'abc');
  assert.equal(isOnCooldown('squawk', 'abc'), true);
});

test('cooldown is scoped per rule type', () => {
  markNotified('squawk', 'abc');
  assert.equal(isOnCooldown('firstSeen', 'abc'), false);
});

test('cooldown is scoped per hex', () => {
  markNotified('squawk', 'abc');
  assert.equal(isOnCooldown('squawk', 'def'), false);
});

test('custom cooldown window expires', (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  markNotified('squawk', 'abc');
  assert.equal(isOnCooldown('squawk', 'abc', 1000), true);
  t.mock.timers.tick(1001);
  assert.equal(isOnCooldown('squawk', 'abc', 1000), false);
});

test('pruneCooldowns removes old entries entirely', (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  markNotified('squawk', 'abc');
  t.mock.timers.tick(25 * 60 * 60 * 1000);
  pruneCooldowns();
  assert.equal(isOnCooldown('squawk', 'abc', Number.MAX_SAFE_INTEGER), false);
});
