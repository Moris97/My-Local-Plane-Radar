import { test } from 'node:test';
import assert from 'node:assert/strict';
import { queuePendingMessage, MAX_PENDING_MESSAGES } from './pending-queue.js';

function delta(n) {
  return { type: 'delta', updated: [{ hex: `a${n}` }] };
}

test('queues snapshots in arrival order', () => {
  const queue = [];
  queuePendingMessage(queue, delta(1));
  queuePendingMessage(queue, delta(2));
  assert.deepEqual(queue.map((s) => s.updated[0].hex), ['a1', 'a2']);
});

test('mutates the array in place so the caller keeps its reference', () => {
  const queue = [];
  const returned = queuePendingMessage(queue, delta(1));
  assert.equal(returned, queue, 'must return the same array object, not a copy');
});

test('a full snapshot discards everything queued before it', () => {
  // handleSnapshot starts a 'full' by calling resetAll(), so replaying the
  // earlier deltas would only redo work that is about to be thrown away.
  const queue = [];
  queuePendingMessage(queue, delta(1));
  queuePendingMessage(queue, delta(2));
  queuePendingMessage(queue, { type: 'full', aircraft: [] });
  assert.equal(queue.length, 1);
  assert.equal(queue[0].type, 'full');
});

test('the queue is capped, dropping the oldest entries', () => {
  // Regression test for a real memory leak: mapReady never becomes true when
  // the Map constructor throws (no WebGL), and the socket keeps delivering a
  // snapshot a second forever.
  const queue = [];
  for (let i = 0; i < MAX_PENDING_MESSAGES + 50; i += 1) {
    queuePendingMessage(queue, delta(i));
  }

  assert.equal(queue.length, MAX_PENDING_MESSAGES);
  // The newest state is what survives -- the last one queued must still be
  // at the end, and the very first must be gone.
  assert.equal(queue[queue.length - 1].updated[0].hex, `a${MAX_PENDING_MESSAGES + 49}`);
  assert.equal(queue[0].updated[0].hex, 'a50');
});

test('stays capped indefinitely rather than growing without bound', () => {
  const queue = [];
  for (let i = 0; i < MAX_PENDING_MESSAGES * 10; i += 1) {
    queuePendingMessage(queue, delta(i));
  }
  assert.equal(queue.length, MAX_PENDING_MESSAGES);
});

test('the cap is configurable, so the bound can be asserted cheaply', () => {
  const queue = [];
  for (let i = 0; i < 10; i += 1) queuePendingMessage(queue, delta(i), 3);
  assert.deepEqual(queue.map((s) => s.updated[0].hex), ['a7', 'a8', 'a9']);
});
