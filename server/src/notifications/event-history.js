// The notification/event history table CLAUDE.md's architecture diagram has
// promised since day one ("SQLite: events + daily aggregates only"). This
// module owns the write side -- an in-memory buffer + periodic flush, same
// dirty-buffer shape as antenna-stats.js/the all-time range record, rather
// than a SQLite write straight from rules.js's per-tick evaluation.
//
// recordEvent() is called from notifications/rules.js right alongside its
// existing emitUiEvent(kind, detail) -- same call sites, same detail
// object, so the stored row is exactly what the live on-map toast already
// renders. No second kind -> label/shape mapping to keep in sync.
import { insertEvents, pruneEventsOlderThan } from '../db.js';

const EVENT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000; // 90 days, per TODO.md's own suggested figure

let pending = [];

// detail.hex is already the aircraft's hex for every kind but
// receiver_silence (which has no aircraft at all, per rules.js's own
// comment on that call site) -- pulled out as its own column so the Stats
// history table can filter/display without parsing every row's JSON.
export function recordEvent(kind, detail) {
  pending.push({ occurredAt: Date.now(), kind, hex: detail.hex ?? null, detail: JSON.stringify(detail) });
}

// Drains the buffer before writing, not after -- an event recorded by a
// concurrent call while insertEvents() is mid-transaction would otherwise
// be silently dropped by a naive `pending = []` reset afterward.
export function flushPendingEventsIfDirty() {
  if (pending.length === 0) return;
  const batch = pending;
  pending = [];
  insertEvents(batch);
}

export function pruneOldEvents(now = Date.now()) {
  pruneEventsOlderThan(now - EVENT_RETENTION_MS);
}

// Test-only: lets tests assert on/reset buffer state without waiting for
// the real flush interval.
export function getPendingEventCountForTests() {
  return pending.length;
}

export function resetPendingEventsForTests() {
  pending = [];
}
