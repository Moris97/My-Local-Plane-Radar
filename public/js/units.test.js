import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatAltitude, formatSpeed, formatVerticalRate, formatDistance } from './units.js';

test('formatAltitude: imperial stays feet, metric converts to meters', () => {
  assert.equal(formatAltitude(35000, 'imperial'), '35000 ft');
  assert.equal(formatAltitude(35000, 'metric'), '10668 m');
});

test('formatAltitude: non-number input yields null', () => {
  assert.equal(formatAltitude(undefined, 'imperial'), null);
  assert.equal(formatAltitude('ground', 'metric'), null);
});

test('formatSpeed: imperial stays knots, metric converts to km/h', () => {
  assert.equal(formatSpeed(420, 'imperial'), '420 kt');
  assert.equal(formatSpeed(420, 'metric'), '778 km/h');
});

test('formatVerticalRate: sign-prefixed in both unit systems', () => {
  assert.equal(formatVerticalRate(800, 'imperial'), '+800 ft/min');
  assert.equal(formatVerticalRate(-800, 'imperial'), '-800 ft/min');
  assert.equal(formatVerticalRate(0, 'imperial'), '0 ft/min');
});

test('formatVerticalRate: metric converts ft/min to m/s, rounded to 1 decimal', () => {
  assert.equal(formatVerticalRate(500, 'metric'), '+2.5 m/s');
  assert.equal(formatVerticalRate(-500, 'metric'), '-2.5 m/s');
});

test('formatDistance: metric stays km (default), imperial converts to nm', () => {
  assert.equal(formatDistance(100, 'metric'), '100 km');
  assert.equal(formatDistance(100, 'imperial'), '54 nm');
});
