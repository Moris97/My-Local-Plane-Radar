import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  noteAircraft,
  removeAircraft,
  clearAircraft,
  notifyAircraftChanged,
  getLiveAircraft,
  getAircraftByHex,
  onChange,
  setMapView,
  getMapView,
} from './radar-state.js';

beforeEach(() => {
  clearAircraft();
  notifyAircraftChanged(); // drain any listeners registered by a previous test
});

test('noteAircraft/removeAircraft/clearAircraft do not notify by themselves', () => {
  // Regression test: these three used to notify on every call, so a WS
  // delta touching dozens of aircraft fired dozens of redraws per second in
  // every listener (list.js rebuilding its whole <table>, in particular).
  // app.js is expected to apply a whole batch, then call
  // notifyAircraftChanged() exactly once.
  let calls = 0;
  const unsubscribe = onChange(() => { calls += 1; });

  noteAircraft('abc123', { hex: 'abc123' });
  noteAircraft('def456', { hex: 'def456' });
  removeAircraft('abc123');
  clearAircraft();

  assert.equal(calls, 0);
  unsubscribe();
});

test('notifyAircraftChanged fires every registered listener exactly once', () => {
  let callsA = 0;
  let callsB = 0;
  const unsubscribeA = onChange(() => { callsA += 1; });
  const unsubscribeB = onChange(() => { callsB += 1; });

  noteAircraft('abc123', { hex: 'abc123' });
  noteAircraft('def456', { hex: 'def456' });
  notifyAircraftChanged();

  assert.equal(callsA, 1);
  assert.equal(callsB, 1);
  unsubscribeA();
  unsubscribeB();
});

test('getLiveAircraft/getAircraftByHex reflect state immediately, independent of notify', () => {
  noteAircraft('abc123', { hex: 'abc123', flight: 'TEST1' });
  noteAircraft('def456', { hex: 'def456', flight: 'TEST2' });

  assert.equal(getLiveAircraft().length, 2);
  assert.equal(getAircraftByHex('abc123').flight, 'TEST1');

  removeAircraft('abc123');
  assert.equal(getLiveAircraft().length, 1);
  assert.equal(getAircraftByHex('abc123'), undefined);
});

test('onChange returns an unsubscribe function', () => {
  let calls = 0;
  const unsubscribe = onChange(() => { calls += 1; });
  notifyAircraftChanged();
  unsubscribe();
  notifyAircraftChanged();

  assert.equal(calls, 1);
});

test('mapView round-trips what app.js pushes into it, and can be cleared', () => {
  // Placeholder coordinates only -- never the real receiver location.
  setMapView({ lat: 50.0, lon: 20.0, zoom: 9 });
  assert.deepEqual(getMapView(), { lat: 50.0, lon: 20.0, zoom: 9 });

  // area-editor.js treats null as "no view yet" and falls back to the home
  // location, so that state has to stay representable.
  setMapView(null);
  assert.equal(getMapView(), null);
});
