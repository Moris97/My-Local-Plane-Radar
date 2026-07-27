import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyAircraftKind } from './aircraft-icon.js';

test('classifyAircraftKind identifies a ground-station beacon by typeCode "TWR"', () => {
  assert.equal(classifyAircraftKind({ typeCode: 'TWR', category: 'A3' }), 'tower');
});

test('classifyAircraftKind identifies a helicopter by ADS-B category A7', () => {
  assert.equal(classifyAircraftKind({ category: 'A7' }), 'helicopter');
});

test('classifyAircraftKind identifies a light aircraft (Cessna 172 class) by ADS-B category A1', () => {
  assert.equal(classifyAircraftKind({ category: 'A1' }), 'light');
});

test('classifyAircraftKind defaults everything else to passenger', () => {
  assert.equal(classifyAircraftKind({ category: 'A3' }), 'passenger');
  assert.equal(classifyAircraftKind({ category: 'A5' }), 'passenger');
  assert.equal(classifyAircraftKind({}), 'passenger');
  assert.equal(classifyAircraftKind(undefined), 'passenger');
});

test('classifyAircraftKind checks typeCode "TWR" before category, since it identifies infrastructure, not an aircraft', () => {
  assert.equal(classifyAircraftKind({ typeCode: 'TWR', category: 'A7' }), 'tower');
});
