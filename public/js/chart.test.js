import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  renderLineChartSvg,
  renderAreaChartSvg,
  renderBarChartSvg,
  renderDoughnutSvg,
  doughnutSlices,
  renderSparklineSvg,
} from './chart.js';

function countOccurrences(text, needle) {
  return text.split(needle).length - 1;
}

test('renderLineChartSvg returns an empty svg for no buckets', () => {
  const svg = renderLineChartSvg([], [{ key: 'v', color: '#fff' }]);
  assert.ok(svg.includes('<svg'));
  assert.ok(!svg.includes('<polyline'));
});

test('renderLineChartSvg draws one polyline per series and labels the max value', () => {
  const buckets = [{ v: 10, w: 5 }, { v: 20, w: 8 }, { v: 15, w: 12 }];
  const series = [{ key: 'v', color: '#3ddc84' }, { key: 'w', color: '#3d8bdc' }];
  const svg = renderLineChartSvg(buckets, series);
  assert.equal(countOccurrences(svg, '<polyline'), 2);
  assert.ok(svg.includes('>20<')); // max across both series
});

test('renderLineChartSvg handles a single bucket without dividing by zero', () => {
  const svg = renderLineChartSvg([{ v: 5 }], [{ key: 'v', color: '#fff' }]);
  assert.ok(!svg.includes('NaN'));
});

test('renderLineChartSvg draws a dot instead of an invisible zero-length polyline for a single bucket', () => {
  // A <polyline> needs >=2 points to draw a visible segment -- common for
  // "all time" on a fresh install with only today's data. Caught via a live
  // screenshot during development: the legend showed real numbers but the
  // chart itself was blank.
  const svg = renderLineChartSvg([{ v: 5 }], [{ key: 'v', color: '#fff' }]);
  assert.ok(!svg.includes('<polyline'));
  assert.ok(svg.includes('<circle'));
});

test('renderAreaChartSvg stacks series -- the first series alone reaches its own value, the second reaches the sum', () => {
  const buckets = [{ a: 10, b: 20 }, { a: 12, b: 18 }];
  const series = [{ key: 'a', color: '#3ddc84' }, { key: 'b', color: '#3d8bdc' }];
  const svg = renderAreaChartSvg(buckets, series);
  assert.equal(countOccurrences(svg, '<polygon'), 2);
});

test('renderAreaChartSvg draws stacked bar-like rects instead of a zero-width sliver for a single bucket', () => {
  const svg = renderAreaChartSvg([{ a: 10, b: 20 }], [{ key: 'a', color: '#3ddc84' }, { key: 'b', color: '#3d8bdc' }]);
  assert.ok(!svg.includes('<polygon'));
  assert.equal(countOccurrences(svg, '<rect'), 2);
});

test('renderAreaChartSvg returns an empty svg for no buckets', () => {
  const svg = renderAreaChartSvg([], [{ key: 'a', color: '#fff' }]);
  assert.ok(!svg.includes('<polygon'));
});

test('renderBarChartSvg draws buckets.length * series.length rects', () => {
  const buckets = [{ a: 1, b: 2 }, { a: 3, b: 4 }, { a: 5, b: 6 }];
  const series = [{ key: 'a', color: '#3ddc84' }, { key: 'b', color: '#3d8bdc' }];
  const svg = renderBarChartSvg(buckets, series);
  assert.equal(countOccurrences(svg, '<rect'), 6);
});

test('renderBarChartSvg never emits a negative bar height', () => {
  const svg = renderBarChartSvg([{ a: 0 }], [{ key: 'a', color: '#fff' }]);
  assert.ok(!svg.includes('height="-'));
});

test('doughnutSlices folds everything beyond maxSlices into one "other" entry', () => {
  const items = [
    { label: 'A', value: 10 },
    { label: 'B', value: 8 },
    { label: 'C', value: 6 },
    { label: 'D', value: 1 },
    { label: 'E', value: 1 },
  ];
  const slices = doughnutSlices(items, { maxSlices: 3, otherLabel: 'Other' });
  assert.equal(slices.length, 4);
  assert.equal(slices[3].label, 'Other');
  assert.equal(slices[3].value, 2);
});

test('doughnutSlices does not add an "other" entry when everything fits', () => {
  const items = [{ label: 'A', value: 10 }, { label: 'B', value: 5 }];
  const slices = doughnutSlices(items, { maxSlices: 6 });
  assert.equal(slices.length, 2);
});

test('renderDoughnutSvg draws one circle arc per slice (after folding)', () => {
  const items = [{ label: 'A', value: 10 }, { label: 'B', value: 5 }];
  const svg = renderDoughnutSvg(items, { maxSlices: 6 });
  assert.equal(countOccurrences(svg, '<circle'), 2);
});

test('renderDoughnutSvg returns an empty svg for no items', () => {
  const svg = renderDoughnutSvg([]);
  assert.ok(!svg.includes('<circle'));
});

test('renderSparklineSvg (pre-existing) still works unchanged', () => {
  const svg = renderSparklineSvg([1, 2, 3]);
  assert.ok(svg.includes('<polyline'));
});
