import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = mkdtempSync(join(tmpdir(), 'mlpr-settings-auth-test-'));
process.env.MLPR_DB_PATH = join(tmpDir, 'test.db');

const auth = await import('./settings-auth.js');

after(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  auth.removePassword();
});

test('no password set initially', () => {
  assert.equal(auth.isPasswordSet(), false);
});

test('setPassword makes isPasswordSet true', () => {
  auth.setPassword('hunter2');
  assert.equal(auth.isPasswordSet(), true);
});

test('verifyPassword accepts the correct password', () => {
  auth.setPassword('hunter2');
  assert.equal(auth.verifyPassword('hunter2'), true);
});

test('verifyPassword rejects an incorrect password', () => {
  auth.setPassword('hunter2');
  assert.equal(auth.verifyPassword('wrong'), false);
});

test('verifyPassword returns false when no password is set', () => {
  assert.equal(auth.verifyPassword('anything'), false);
});

test('issued tokens are valid immediately', () => {
  const token = auth.issueToken();
  assert.equal(auth.isValidToken(token), true);
});

test('an unknown token is not valid', () => {
  assert.equal(auth.isValidToken('made-up-token'), false);
});

test('a token expires after its TTL', (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const token = auth.issueToken();
  assert.equal(auth.isValidToken(token), true);
  t.mock.timers.tick(25 * 60 * 60 * 1000);
  assert.equal(auth.isValidToken(token), false);
});

test('setPassword invalidates previously issued tokens', () => {
  auth.setPassword('first');
  const token = auth.issueToken();
  assert.equal(auth.isValidToken(token), true);
  auth.setPassword('second');
  assert.equal(auth.isValidToken(token), false);
});

test('removePassword invalidates previously issued tokens', () => {
  auth.setPassword('first');
  const token = auth.issueToken();
  auth.removePassword();
  assert.equal(auth.isValidToken(token), false);
  assert.equal(auth.isPasswordSet(), false);
});

test('an IP is not locked out before any failed attempts', () => {
  assert.equal(auth.isLockedOut('1.2.3.4'), false);
});

test('an IP is not locked out after fewer than the max failed attempts', () => {
  for (let i = 0; i < 4; i++) auth.recordFailedAttempt('1.2.3.5');
  assert.equal(auth.isLockedOut('1.2.3.5'), false);
});

test('an IP is locked out once it reaches the max failed attempts', () => {
  for (let i = 0; i < 5; i++) auth.recordFailedAttempt('1.2.3.6');
  assert.equal(auth.isLockedOut('1.2.3.6'), true);
});

test('a successful attempt clears a previously failing IP', () => {
  for (let i = 0; i < 4; i++) auth.recordFailedAttempt('1.2.3.7');
  auth.recordSuccessfulAttempt('1.2.3.7');
  assert.equal(auth.isLockedOut('1.2.3.7'), false);
});

test('lockout expires after the lockout window', (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  for (let i = 0; i < 5; i++) auth.recordFailedAttempt('1.2.3.8');
  assert.equal(auth.isLockedOut('1.2.3.8'), true);
  t.mock.timers.tick(6 * 60 * 1000);
  assert.equal(auth.isLockedOut('1.2.3.8'), false);
});

test('a different IP is unaffected by another IP being locked out', () => {
  for (let i = 0; i < 5; i++) auth.recordFailedAttempt('1.2.3.9');
  assert.equal(auth.isLockedOut('1.2.3.10'), false);
});

test('pruneLoginAttempts removes only expired lockouts', (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  for (let i = 0; i < 5; i++) auth.recordFailedAttempt('1.2.3.11');
  for (let i = 0; i < 2; i++) auth.recordFailedAttempt('1.2.3.12');
  t.mock.timers.tick(6 * 60 * 1000);
  auth.pruneLoginAttempts();
  // The expired lockout is gone (a fresh attempt starts a new count, not
  // an immediate re-lockout)...
  auth.recordFailedAttempt('1.2.3.11');
  assert.equal(auth.isLockedOut('1.2.3.11'), false);
  // ...while an IP that was never locked out (just a couple of failures)
  // is untouched by the prune.
  auth.recordFailedAttempt('1.2.3.12');
  auth.recordFailedAttempt('1.2.3.12');
  auth.recordFailedAttempt('1.2.3.12');
  assert.equal(auth.isLockedOut('1.2.3.12'), true);
});
