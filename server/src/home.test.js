import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = mkdtempSync(join(tmpdir(), 'mlpr-home-test-'));
process.env.MLPR_DB_PATH = join(tmpDir, 'test.db');

const home = await import('./home.js');

after(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

test('no auto-detected and no manual override returns null', () => {
  assert.equal(home.getEffectiveHome(), null);
});

test('auto-detected home is used once set', () => {
  home.setAutoDetectedHome({ lat: 10, lon: 20, version: 'test' });
  assert.deepEqual(home.getEffectiveHome(), { lat: 10, lon: 20, source: 'receiver.json' });
});

test('receiver info missing lat/lon is ignored', () => {
  home.setAutoDetectedHome({ lat: 10, lon: 20, version: 'test' });
  home.setAutoDetectedHome({ version: 'no-position' });
  assert.deepEqual(home.getEffectiveHome(), { lat: 10, lon: 20, source: 'receiver.json' });
});

test('manual override takes priority over auto-detected', () => {
  home.setAutoDetectedHome({ lat: 10, lon: 20 });
  home.setManualHome(30, 40);
  assert.deepEqual(home.getEffectiveHome(), { lat: 30, lon: 40, source: 'manual' });
});

test('clearing the manual override falls back to auto-detected', () => {
  home.setAutoDetectedHome({ lat: 10, lon: 20 });
  home.setManualHome(30, 40);
  home.clearManualHome();
  assert.deepEqual(home.getEffectiveHome(), { lat: 10, lon: 20, source: 'receiver.json' });
});
