import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  renderLineChartSvg,
  renderAreaChartSvg,
  renderBarChartSvg,
  renderDoughnutSvg,
  doughnutSlices,
  renderSparklineSvg,
  renderRoseChartSvg,
  formatBucketLabel,
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
  assert.equal(countOccurrences(svg, '<rect class="mlpr-chart-area"'), 2);
});

test('renderAreaChartSvg returns an empty svg for no buckets', () => {
  const svg = renderAreaChartSvg([], [{ key: 'a', color: '#fff' }]);
  assert.ok(!svg.includes('<polygon'));
});

test('renderBarChartSvg draws buckets.length * series.length rects', () => {
  const buckets = [{ a: 1, b: 2 }, { a: 3, b: 4 }, { a: 5, b: 6 }];
  const series = [{ key: 'a', color: '#3ddc84' }, { key: 'b', color: '#3d8bdc' }];
  const svg = renderBarChartSvg(buckets, series);
  assert.equal(countOccurrences(svg, '<rect class="mlpr-chart-bar"'), 6);
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

test('formatBucketLabel formats an hour bucket key as day.month hour:00', () => {
  assert.equal(formatBucketLabel('2026-07-27T14'), '27.07 14:00');
});

test('formatBucketLabel formats a day bucket key as day.month.year', () => {
  assert.equal(formatBucketLabel('2026-07-27'), '27.07.2026');
});

test('formatBucketLabel leaves an ISO week bucket key as-is', () => {
  assert.equal(formatBucketLabel('2026-W30'), '2026-W30');
});

test('formatBucketLabel formats a month bucket key as month.year', () => {
  assert.equal(formatBucketLabel('2026-07'), '07.2026');
});

test('formatBucketLabel returns an empty string for a missing/non-string key', () => {
  assert.equal(formatBucketLabel(undefined), '');
});

test('renderLineChartSvg preserves the SVG aspect ratio via preserveAspectRatio="none" so it fills its container width instead of letterboxing', () => {
  const svg = renderLineChartSvg([{ v: 1 }, { v: 2 }], [{ key: 'v', color: '#fff' }]);
  assert.ok(svg.includes('preserveAspectRatio="none"'));
});

test('renderLineChartSvg labels the Y axis with max/mid/zero values, unit-formatted via formatValue', () => {
  const buckets = [{ v: 100 }, { v: 200 }];
  const svg = renderLineChartSvg(buckets, [{ key: 'v', color: '#fff' }], { formatValue: (v) => `${Math.round(v)} km` });
  assert.ok(svg.includes('>200 km<'));
  assert.ok(svg.includes('>100 km<'));
  assert.ok(svg.includes('>0 km<'));
});

test('renderLineChartSvg labels the X axis with the first and last bucket, formatted as a time scale', () => {
  const buckets = [{ v: 1, bucket: '2026-07-25' }, { v: 2, bucket: '2026-07-26' }, { v: 3, bucket: '2026-07-27' }];
  const svg = renderLineChartSvg(buckets, [{ key: 'v', color: '#fff' }]);
  assert.ok(svg.includes('>25.07.2026<'));
  assert.ok(svg.includes('>27.07.2026<'));
  assert.ok(!svg.includes('>26.07.2026<')); // only start/end are labeled, not the middle
});

test('renderBarChartSvg also carries Y-axis units and X-axis time labels', () => {
  const buckets = [{ a: 150, bucket: '2026-07-26' }, { a: 180, bucket: '2026-07-27' }];
  const svg = renderBarChartSvg(buckets, [{ key: 'a', color: '#3ddc84' }], { formatValue: (v) => `${Math.round(v)} km` });
  assert.ok(svg.includes('>180 km<'));
  assert.ok(svg.includes('>26.07.2026<'));
  assert.ok(svg.includes('>27.07.2026<'));
});

test('renderAreaChartSvg also carries Y-axis units and X-axis time labels', () => {
  const buckets = [{ a: 5, b: 5, bucket: '2026-07-26' }, { a: 10, b: 10, bucket: '2026-07-27' }];
  const svg = renderAreaChartSvg(buckets, [{ key: 'a', color: '#3ddc84' }, { key: 'b', color: '#3d8bdc' }]);
  assert.ok(svg.includes('>26.07.2026<'));
  assert.ok(svg.includes('>27.07.2026<'));
});

test('renderRoseChartSvg returns an empty svg for no items', () => {
  const svg = renderRoseChartSvg([]);
  assert.ok(svg.includes('<svg'));
  assert.ok(!svg.includes('<path'));
});

test('renderRoseChartSvg draws one petal per item with a nonzero value, skipping zero-value sectors', () => {
  const items = [
    { label: 'N', value: 100 },
    { label: 'E', value: 0 },
    { label: 'S', value: 50 },
    { label: 'W', value: 0 },
  ];
  const svg = renderRoseChartSvg(items);
  assert.equal((svg.match(/<path/g) ?? []).length, 2);
});

test('renderRoseChartSvg draws the four cardinal direction labels', () => {
  const items = [{ label: 'N', value: 10 }, { label: 'E', value: 20 }, { label: 'S', value: 5 }, { label: 'W', value: 15 }];
  const svg = renderRoseChartSvg(items);
  for (const cardinal of ['N', 'E', 'S', 'W']) {
    assert.ok(svg.includes(`>${cardinal}<`), `expected a "${cardinal}" label`);
  }
});

test('renderRoseChartSvg labels the outer ring with the max value, unit-formatted via formatValue', () => {
  const items = [{ label: 'N', value: 123 }, { label: 'E', value: 45 }];
  const svg = renderRoseChartSvg(items, { formatValue: (v) => `${Math.round(v)} km` });
  assert.ok(svg.includes('>123 km<'));
});

test('renderRoseChartSvg never produces NaN in its path data, even with a single item', () => {
  const svg = renderRoseChartSvg([{ label: 'N', value: 10 }]);
  assert.ok(!svg.includes('NaN'));
});

// ---- hover affordances: hit regions, cursor guide, per-bucket point markers ----

test('renderLineChartSvg emits one hit region and one cursor line per bucket, plus one point per bucket per series', () => {
  const buckets = [{ v: 10, w: 5 }, { v: 20, w: 8 }, { v: 15, w: 12 }];
  const series = [{ key: 'v', color: '#3ddc84' }, { key: 'w', color: '#3d8bdc' }];
  const svg = renderLineChartSvg(buckets, series);
  assert.equal(countOccurrences(svg, '<rect class="mlpr-chart-hit"'), 3);
  assert.equal(countOccurrences(svg, '<line class="mlpr-chart-cursor"'), 3);
  assert.equal(countOccurrences(svg, '<circle class="mlpr-chart-point"'), 6);
  for (const i of [0, 1, 2]) {
    assert.ok(svg.includes(`data-i="${i}"`), `expected a data-i="${i}" element`);
  }
});

test('renderLineChartSvg still emits exactly one hit region for a single bucket', () => {
  const svg = renderLineChartSvg([{ v: 5 }], [{ key: 'v', color: '#fff' }]);
  assert.equal(countOccurrences(svg, '<rect class="mlpr-chart-hit"'), 1);
  assert.ok(svg.includes('data-i="0"'));
});

test("renderLineChartSvg's hit regions tile the plot edge-to-edge with no gaps or overlaps", () => {
  const buckets = [{ v: 1 }, { v: 2 }, { v: 3 }, { v: 4 }];
  const svg = renderLineChartSvg(buckets, [{ key: 'v', color: '#fff' }], { width: 400 });
  const xs = [...svg.matchAll(/<rect class="mlpr-chart-hit" data-i="\d+" x="([\d.]+)" y="[\d.]+" width="([\d.]+)"/g)].map((m) => [
    Number(m[1]),
    Number(m[2]),
  ]);
  assert.equal(xs.length, 4);
  for (let i = 1; i < xs.length; i += 1) {
    const prevRight = xs[i - 1][0] + xs[i - 1][1];
    assert.ok(Math.abs(prevRight - xs[i][0]) < 0.05, `expected region ${i} to start where region ${i - 1} ends`);
  }
});

test('renderAreaChartSvg emits one point per bucket per series, at the top of that series own stacked layer', () => {
  const buckets = [{ a: 10, b: 20 }, { a: 12, b: 18 }];
  const series = [{ key: 'a', color: '#3ddc84' }, { key: 'b', color: '#3d8bdc' }];
  const svg = renderAreaChartSvg(buckets, series);
  assert.equal(countOccurrences(svg, '<circle class="mlpr-chart-point"'), 4);
  assert.equal(countOccurrences(svg, '<rect class="mlpr-chart-hit"'), 2);
});

test('renderBarChartSvg emits one hit region per bucket (not per bar)', () => {
  const buckets = [{ a: 1, b: 2 }, { a: 3, b: 4 }, { a: 5, b: 6 }];
  const series = [{ key: 'a', color: '#3ddc84' }, { key: 'b', color: '#3d8bdc' }];
  const svg = renderBarChartSvg(buckets, series);
  assert.equal(countOccurrences(svg, '<rect class="mlpr-chart-hit"'), 3);
});

test('renderBarChartSvg tags every bar with its bucket index so a hover can highlight the whole group', () => {
  const buckets = [{ a: 1, b: 2 }, { a: 3, b: 4 }];
  const series = [{ key: 'a', color: '#3ddc84' }, { key: 'b', color: '#3d8bdc' }];
  const svg = renderBarChartSvg(buckets, series);
  assert.equal(countOccurrences(svg, '<rect class="mlpr-chart-bar" data-i="0"'), 2);
  assert.equal(countOccurrences(svg, '<rect class="mlpr-chart-bar" data-i="1"'), 2);
});
