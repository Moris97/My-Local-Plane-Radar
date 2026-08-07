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
  const { updated } = applyRawSnapshot({ aircraft: [aircraftFixture()] });
  assert.equal(updated.length, 1);
  assert.equal(updated[0].hex, 'abc123');
});

test('unchanged aircraft is not resent on the next tick', () => {
  applyRawSnapshot({ aircraft: [aircraftFixture()] });
  const { updated: second } = applyRawSnapshot({ aircraft: [aircraftFixture()] });
  assert.equal(second.length, 0);
});

test('a changed tracked field causes the aircraft to be resent', () => {
  applyRawSnapshot({ aircraft: [aircraftFixture()] });
  const { updated: second } = applyRawSnapshot({ aircraft: [aircraftFixture({ lat: 52.01 })] });
  assert.equal(second.length, 1);
});

test('volatile fields (rssi/messages/seen/seen_pos) alone do not trigger a resend', () => {
  applyRawSnapshot({ aircraft: [aircraftFixture({ rssi: -10, messages: 100, seen: 0.1, seen_pos: 0.1 })] });
  const { updated: second } = applyRawSnapshot({
    aircraft: [aircraftFixture({ rssi: -20, messages: 200, seen: 1.1, seen_pos: 1.1 })],
  });
  assert.equal(second.length, 0);
});

test('a changed speed/nav field (e.g. ias) also causes a resend', () => {
  applyRawSnapshot({ aircraft: [aircraftFixture({ ias: 280 })] });
  const { updated: second } = applyRawSnapshot({ aircraft: [aircraftFixture({ ias: 285 })] });
  assert.equal(second.length, 1);
});

test('data-quality fields (nic/rc/nac_p/gva) alone do not trigger a resend', () => {
  applyRawSnapshot({ aircraft: [aircraftFixture({ nic: 8, rc: 100, nac_p: 9, gva: 2 })] });
  const { updated: second } = applyRawSnapshot({
    aircraft: [aircraftFixture({ nic: 6, rc: 200, nac_p: 7, gva: 1 })],
  });
  assert.equal(second.length, 0);
});

test('nav_modes alone does not trigger a resend (array identity, not compared)', () => {
  applyRawSnapshot({ aircraft: [aircraftFixture({ nav_modes: ['autopilot'] })] });
  const { updated: second } = applyRawSnapshot({ aircraft: [aircraftFixture({ nav_modes: ['autopilot', 'althold'] })] });
  assert.equal(second.length, 0);
});

test('getTrackedAircraft reflects the latest snapshot even when unchanged', () => {
  applyRawSnapshot({ aircraft: [aircraftFixture()] });
  applyRawSnapshot({ aircraft: [aircraftFixture()] });
  const tracked = getTrackedAircraft();
  assert.equal(tracked.length, 1);
  assert.equal(tracked[0].hex, 'abc123');
});

test('an aircraft readsb stops reporting is announced as removed, once', () => {
  applyRawSnapshot({ aircraft: [aircraftFixture()] });

  const first = applyRawSnapshot({ aircraft: [] });
  assert.deepEqual(first.removed, ['abc123']);

  // Not re-announced every tick until eviction -- the browser acted on the
  // first one, and repeating it would be a needless per-second payload.
  const second = applyRawSnapshot({ aircraft: [] });
  assert.deepEqual(second.removed, []);
});

test('nothing is announced as removed while the aircraft keeps being reported', () => {
  applyRawSnapshot({ aircraft: [aircraftFixture()] });
  const second = applyRawSnapshot({ aircraft: [aircraftFixture()] });
  assert.deepEqual(second.removed, []);
});

test('a returning aircraft is resent even when every tracked field is unchanged', () => {
  applyRawSnapshot({ aircraft: [aircraftFixture()] });
  applyRawSnapshot({ aircraft: [] });

  // Byte-identical to the original: hasChanged alone says "no change", so
  // without the present===false check the browser -- which has already
  // dropped this hex -- would never hear about it again.
  const back = applyRawSnapshot({ aircraft: [aircraftFixture()] });
  assert.equal(back.updated.length, 1);
  assert.equal(back.updated[0].hex, 'abc123');
});

test('a returning aircraft can be announced as removed a second time', () => {
  applyRawSnapshot({ aircraft: [aircraftFixture()] });
  applyRawSnapshot({ aircraft: [] });
  applyRawSnapshot({ aircraft: [aircraftFixture()] });

  const goneAgain = applyRawSnapshot({ aircraft: [] });
  assert.deepEqual(goneAgain.removed, ['abc123']);
});

test('aircraft not seen for the eviction window are dropped from tracked state', (t) => {
  t.mock.timers.enable({ apis: ['Date'] });

  applyRawSnapshot({ aircraft: [aircraftFixture()] });
  assert.equal(getTrackedAircraft().length, 1);

  t.mock.timers.tick(5 * 60 * 1000 + 1000);
  applyRawSnapshot({ aircraft: [] });

  assert.equal(getTrackedAircraft().length, 0);
});
