import { test } from 'node:test';
import assert from 'node:assert/strict';
import { colorForElapsed, colorForSpeed } from './aircraft-color.js';

const FADE_START = 3000;
const FADE_END = 10000;

test('colorForElapsed stays fresh green until the fade start threshold', () => {
  assert.equal(colorForElapsed(0, FADE_START, FADE_END), 'rgb(61,220,132)');
  assert.equal(colorForElapsed(FADE_START, FADE_START, FADE_END), 'rgb(61,220,132)');
});

test('colorForElapsed reaches stale red at and beyond the fade end threshold', () => {
  assert.equal(colorForElapsed(FADE_END, FADE_START, FADE_END), 'rgb(224,49,49)');
  assert.equal(colorForElapsed(FADE_END + 5000, FADE_START, FADE_END), 'rgb(224,49,49)');
});

test('colorForElapsed is partway between fresh and stale at the midpoint', () => {
  const mid = FADE_START + (FADE_END - FADE_START) / 2;
  assert.equal(colorForElapsed(mid, FADE_START, FADE_END), 'rgb(143,135,91)');
});

test('colorForSpeed is green at 0 kt and red by 450 kt, clamped beyond', () => {
  assert.equal(colorForSpeed(0), 'rgb(61,220,132)');
  assert.equal(colorForSpeed(450), 'rgb(224,49,49)');
  assert.equal(colorForSpeed(900), 'rgb(224,49,49)');
});

test('colorForSpeed treats a missing speed as 0 kt (green)', () => {
  assert.equal(colorForSpeed(undefined), colorForSpeed(0));
});

function saturationOf(rgbString) {
  const [r, g, b] = rgbString.match(/\d+/g).map(Number).map((v) => v / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return 0;
  return l > 0.5 ? d / (2 - max - min) : d / (max + min);
}

test('colorForSpeed stays vivid across the whole scale, no washed-out midpoint', () => {
  for (let kt = 0; kt <= 450; kt += 25) {
    const saturation = saturationOf(colorForSpeed(kt));
    assert.ok(saturation > 0.5, `${kt} kt produced a washed-out colour (saturation ${(saturation * 100).toFixed(0)}%)`);
  }
});
