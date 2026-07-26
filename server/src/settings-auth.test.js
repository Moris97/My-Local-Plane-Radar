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
