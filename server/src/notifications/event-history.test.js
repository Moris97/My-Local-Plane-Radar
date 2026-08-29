import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = mkdtempSync(join(tmpdir(), 'mlpr-event-history-test-'));
process.env.MLPR_DB_PATH = join(tmpDir, 'test.db');

const { getEventsPage } = await import('../db.js');
const { recordEvent, flushPendingEventsIfDirty, pruneOldEvents, getPendingEventCountForTests, resetPendingEventsForTests } =
  await import('./event-history.js');

after(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

test('recordEvent buffers in memory without touching SQLite', () => {
  resetPendingEventsForTests();
  recordEvent('squawk', { hex: 'aa0001', squawk: '7700' });
  assert.equal(getPendingEventCountForTests(), 1);
  assert.equal(getEventsPage({}).total, 0, 'nothing written until a flush');
});

test('flushPendingEventsIfDirty drains the buffer into SQLite', () => {
  resetPendingEventsForTests();
  recordEvent('first_seen', { hex: 'aa0002' });
  flushPendingEventsIfDirty();
  assert.equal(getPendingEventCountForTests(), 0);

  const page = getEventsPage({ kind: 'first_seen' });
  assert.ok(page.rows.some((r) => r.hex === 'aa0002'));
});

test('flushPendingEventsIfDirty is a no-op with nothing pending', () => {
  resetPendingEventsForTests();
  const before = getEventsPage({}).total;
  flushPendingEventsIfDirty();
  assert.equal(getEventsPage({}).total, before);
});

test('recordEvent stores detail.hex as the row hex, and null when absent (receiver_silence)', () => {
  resetPendingEventsForTests();
  recordEvent('receiver_silence', { hours: 2 });
  flushPendingEventsIfDirty();
  const page = getEventsPage({ kind: 'receiver_silence' });
  const row = page.rows.find((r) => r.hours === 2);
  assert.equal(row.hex, null);
});

test('pruneOldEvents removes rows older than the retention window', () => {
  resetPendingEventsForTests();
  recordEvent('watchlist', { hex: 'aa0003' });
  flushPendingEventsIfDirty();

  const ninetyOneDaysFromNow = Date.now() + 91 * 24 * 60 * 60 * 1000;
  pruneOldEvents(ninetyOneDaysFromNow);

  const page = getEventsPage({ kind: 'watchlist' });
  assert.equal(page.rows.some((r) => r.hex === 'aa0003'), false);
});
