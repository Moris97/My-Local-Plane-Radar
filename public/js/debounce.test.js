import { test } from 'node:test';
import assert from 'node:assert/strict';
import { debounce } from './debounce.js';

const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('collapses a burst of calls into a single trailing run', async () => {
  let calls = 0;
  const fn = debounce(() => { calls += 1; }, 20);
  for (let i = 0; i < 10; i += 1) fn();
  assert.equal(calls, 0, 'nothing runs while the burst is still going');
  await tick(50);
  assert.equal(calls, 1, 'exactly one run after the burst settles');
});

test('passes through the most recent arguments, not the first', async () => {
  // A search box must end up filtering on the final query, not whatever was
  // typed first.
  let seen = null;
  const fn = debounce((value) => { seen = value; }, 20);
  fn('a'); fn('ab'); fn('abc');
  await tick(50);
  assert.equal(seen, 'abc');
});

test('separate bursts each get their own run', async () => {
  let calls = 0;
  const fn = debounce(() => { calls += 1; }, 20);
  fn();
  await tick(50);
  fn();
  await tick(50);
  assert.equal(calls, 2);
});
