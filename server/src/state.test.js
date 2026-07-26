import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { applyRawSnapshot, getTrackedAircraft, resetTrackedState } from './state.js';

beforeEach(() => {
  resetTrackedState();
});

function aircraftFixture(overrides = {}) {
  return {
    hex: 'abc123',
    lat: 52.0,
    lon: 20.0,
    alt_baro: 5000,
    track: 90,
    gs: 200,
    ...overrides,
  };
}

test('new hex is included in the delta', () => {
  const updated = applyRawSnapshot({ aircraft: [aircraftFixture()] });
  assert.equal(updated.length, 1);
  assert.equal(updated[0].hex, 'abc123');
});

test('unchanged aircraft is not resent on the next tick', () => {
  applyRawSnapshot({ aircraft: [aircraftFixture()] });
  const second = applyRawSnapshot({ aircraft: [aircraftFixture()] });
  assert.equal(second.length, 0);
});

test('a changed tracked field causes the aircraft to be resent', () => {
  applyRawSnapshot({ aircraft: [aircraftFixture()] });
  const second = applyRawSnapshot({ aircraft: [aircraftFixture({ lat: 52.01 })] });
  assert.equal(second.length, 1);
});

test('volatile fields (rssi/messages/seen/seen_pos) alone do not trigger a resend', () => {
  applyRawSnapshot({ aircraft: [aircraftFixture({ rssi: -10, messages: 100, seen: 0.1, seen_pos: 0.1 })] });
  const second = applyRawSnapshot({
    aircraft: [aircraftFixture({ rssi: -20, messages: 200, seen: 1.1, seen_pos: 1.1 })],
  });
  assert.equal(second.length, 0);
});

test('getTrackedAircraft reflects the latest snapshot even when unchanged', () => {
  applyRawSnapshot({ aircraft: [aircraftFixture()] });
  applyRawSnapshot({ aircraft: [aircraftFixture()] });
  const tracked = getTrackedAircraft();
  assert.equal(tracked.length, 1);
  assert.equal(tracked[0].hex, 'abc123');
});

test('aircraft not seen for the eviction window are dropped from tracked state', (t) => {
  t.mock.timers.enable({ apis: ['Date'] });

  applyRawSnapshot({ aircraft: [aircraftFixture()] });
  assert.equal(getTrackedAircraft().length, 1);

  t.mock.timers.tick(5 * 60 * 1000 + 1000);
  applyRawSnapshot({ aircraft: [] });

  assert.equal(getTrackedAircraft().length, 0);
});
