export const DOUGHNUT_COLORS = ['#3ddc84', '#3d8bdc', '#dc9d3d', '#a83ddc', '#dc3d5e', '#3ddcc4', '#8a8a8a'];

const PAD_TOP = 16;
const PAD_RIGHT = 10;
const PAD_BOTTOM = 18;
const PAD_LEFT = 46;

function emptyChartSvg(width, height) {
  return `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" class="mlpr-chart"></svg>`;
}

// Exported so stats.js's hover tooltip can fall back to the exact same
// default the charts themselves use for their Y-axis labels when a chart
// was drawn without its own formatValue.
export function defaultFormatValue(value) {
  return String(Math.round(value));
}

// Bucket keys come straight from server/src/time-buckets.js's bucketKey():
// "YYYY-MM-DDTHH" (hour), "YYYY-MM-DD" (day), "YYYY-Www" (ISO week), or
// "YYYY-MM" (month). Used for the chart's X-axis start/end labels.
export function formatBucketLabel(key) {
  if (typeof key !== 'string') return '';
  const hourMatch = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})$/.exec(key);
  if (hourMatch) {
    // Keys are already in the server's local time (time-buckets.js builds
    // every key off local calendar fields, deliberately never
    // toISOString()), so the label is a straight reformat -- no timezone
    // conversion here, and adding one would double-shift it.
    const [, , month, day, hour] = hourMatch;
    return `${day}.${month} ${hour}:00`;
  }
  const dayMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (dayMatch) {
    const [, year, month, day] = dayMatch;
    return `${day}.${month}.${year}`;
  }
  if (/^\d{4}-W\d{2}$/.test(key)) return key;
  const monthMatch = /^(\d{4})-(\d{2})$/.exec(key);
  if (monthMatch) {
    const [, year, month] = monthMatch;
    return `${month}.${year}`;
  }
  return key;
}

function plotX(i, count, left, plotWidth) {
  return left + (count <= 1 ? plotWidth / 2 : (i / (count - 1)) * plotWidth);
}

// Invisible full-height hit regions, one per bucket, tiled edge-to-edge
// across the plot so hovering anywhere above/below a point (not just
// exactly on the line) still targets that bucket -- a bare few-pixel-wide
// <circle> would be a tiny, easy-to-miss target otherwise. Each bucket's
// region is a Voronoi-style slice: it extends halfway to its neighbours on
// either side (or to the plot edge for the first/last bucket), so there's
// no dead zone between points and no ambiguity about which bucket a given
// x belongs to. stats.js reads back the `data-i` index on
// pointer/mouse events rather than recomputing this geometry itself --
// same reasoning as the rectangle trigger area's shared destinationPoint()
// calls: the hit-test and the drawing must come from the exact same
// numbers or they can silently disagree.
function pointHitRegionsSvg(buckets, left, plotWidth, top, plotHeight) {
  if (buckets.length <= 1) {
    return `<rect class="mlpr-chart-hit" data-i="0" x="${left.toFixed(1)}" y="${top.toFixed(1)}" width="${plotWidth.toFixed(1)}" height="${plotHeight.toFixed(1)}" />`;
  }
  const xs = buckets.map((b, i) => plotX(i, buckets.length, left, plotWidth));
  return buckets
    .map((b, i) => {
      const x0 = i === 0 ? left : (xs[i - 1] + xs[i]) / 2;
      const x1 = i === buckets.length - 1 ? left + plotWidth : (xs[i] + xs[i + 1]) / 2;
      return `<rect class="mlpr-chart-hit" data-i="${i}" x="${x0.toFixed(1)}" y="${top.toFixed(1)}" width="${(x1 - x0).toFixed(1)}" height="${plotHeight.toFixed(1)}" />`;
    })
    .join('');
}

// One vertical guide per bucket, hidden by default (style.css) and toggled
// on via the `.active` class by stats.js's hover handler -- positioning
// stays entirely in this file rather than being recomputed in the DOM
// layer, so it can never drift from where the data actually is.
function cursorLinesSvg(buckets, left, plotWidth, top, plotHeight) {
  if (buckets.length <= 1) {
    const x = (left + plotWidth / 2).toFixed(1);
    return `<line class="mlpr-chart-cursor" data-i="0" x1="${x}" x2="${x}" y1="${top.toFixed(1)}" y2="${(top + plotHeight).toFixed(1)}" />`;
  }
  return buckets
    .map((b, i) => {
      const x = plotX(i, buckets.length, left, plotWidth).toFixed(1);
      return `<line class="mlpr-chart-cursor" data-i="${i}" x1="${x}" x2="${x}" y1="${top.toFixed(1)}" y2="${(top + plotHeight).toFixed(1)}" />`;
    })
    .join('');
}

function gridLinesSvg(left, top, plotWidth, plotHeight) {
  return [0, 0.5, 1]
    .map((f) => {
      const y = (top + plotHeight * f).toFixed(1);
      return `<line x1="${left}" x2="${left + plotWidth}" y1="${y}" y2="${y}" stroke="#14212b" stroke-width="1" />`;
    })
    .join('');
}

// Three labeled gridlines (max / mid / zero) so a chart always carries its
// own scale instead of relying on the legend alone -- formatValue lets the
// caller attach units (e.g. "205 km") rather than a bare number.
function yAxisLabelsSvg(left, top, plotHeight, maxValue, formatValue) {
  return [0, 0.5, 1]
    .map((f) => {
      const y = top + plotHeight * f;
      const value = maxValue * (1 - f);
      return `<text x="${(left - 6).toFixed(1)}" y="${(y + 3).toFixed(1)}" fill="#7fa3b3" font-size="9" text-anchor="end">${formatValue(value)}</text>`;
    })
    .join('');
}

// Start/end bucket labels below the plot, giving the chart a time scale --
// otherwise there's no way to tell what span of time is even being shown.
function xAxisLabelsSvg(buckets, left, plotWidth, y, formatBucket) {
  if (buckets.length === 0) return '';
  if (buckets.length === 1) {
    return `<text x="${(left + plotWidth / 2).toFixed(1)}" y="${y}" fill="#5c7885" font-size="9" text-anchor="middle">${formatBucket(buckets[0].bucket)}</text>`;
  }
  return (
    `<text x="${left.toFixed(1)}" y="${y}" fill="#5c7885" font-size="9" text-anchor="start">${formatBucket(buckets[0].bucket)}</text>` +
    `<text x="${(left + plotWidth).toFixed(1)}" y="${y}" fill="#5c7885" font-size="9" text-anchor="end">${formatBucket(buckets[buckets.length - 1].bucket)}</text>`
  );
}

// series: [{ key, color }], each bucket in `buckets` is read via bucket[key].
export function renderLineChartSvg(
  buckets,
  series,
  { width = 560, height = 170, formatValue = defaultFormatValue, formatBucket = formatBucketLabel } = {},
) {
  if (buckets.length === 0) return emptyChartSvg(width, height);

  const left = PAD_LEFT;
  const top = PAD_TOP;
  const plotWidth = width - left - PAD_RIGHT;
  const plotHeight = height - top - PAD_BOTTOM;
  const maxValue = Math.max(1, ...buckets.flatMap((b) => series.map((s) => b[s.key] ?? 0)));

  // Points are collected alongside the polylines (same coords, one pass)
  // rather than recomputed separately -- both a hover dot per bucket and
  // the fallback single-bucket dot need the exact same y as the line
  // itself, so there's one source of truth for "where does this series
  // sit at bucket i" instead of two formulas that could drift apart.
  let points = '';
  const polylines = series
    .map((s) => {
      const coords = buckets.map((b, i) => [
        plotX(i, buckets.length, left, plotWidth),
        top + plotHeight - ((b[s.key] ?? 0) / maxValue) * plotHeight,
      ]);
      points += coords
        .map(([x, y], i) => `<circle class="mlpr-chart-point" data-i="${i}" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3" fill="${s.color}" />`)
        .join('');
      // A single point produces an invisible polyline (needs >=2 points to
      // draw a segment) -- always common for "all time" on a fresh install
      // with only today's data. Draw it as a dot instead of silently
      // showing nothing. Drawn full-size and always visible (not one of
      // the hidden-until-hover dots above) since it's the chart's only
      // visible mark either way.
      if (coords.length === 1) {
        const [x, y] = coords[0];
        return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3" fill="${s.color}" />`;
      }
      return `<polyline class="mlpr-chart-line" points="${coords.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ')}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />`;
    })
    .join('');

  return `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" class="mlpr-chart">
    ${gridLinesSvg(left, top, plotWidth, plotHeight)}
    ${polylines}
    ${cursorLinesSvg(buckets, left, plotWidth, top, plotHeight)}
    ${points}
    ${yAxisLabelsSvg(left, top, plotHeight, maxValue, formatValue)}
    ${xAxisLabelsSvg(buckets, left, plotWidth, height - 4, formatBucket)}
    ${pointHitRegionsSvg(buckets, left, plotWidth, top, plotHeight)}
  </svg>`;
}

// Stacked area: series drawn bottom-to-top in the order given, each bucket's
// series values summed for the total stack height.
export function renderAreaChartSvg(
  buckets,
  series,
  { width = 560, height = 170, formatValue = defaultFormatValue, formatBucket = formatBucketLabel } = {},
) {
  if (buckets.length === 0) return emptyChartSvg(width, height);

  const left = PAD_LEFT;
  const top = PAD_TOP;
  const plotWidth = width - left - PAD_RIGHT;
  const plotHeight = height - top - PAD_BOTTOM;
  const totals = buckets.map((b) => series.reduce((sum, s) => sum + (b[s.key] ?? 0), 0));
  const maxTotal = Math.max(1, ...totals);

  const toY = (v) => top + plotHeight - (v / maxTotal) * plotHeight;

  // A single bucket produces a zero-width polygon (there's no "area" with
  // only one x position) -- draw a bar-like column per layer instead of
  // silently showing a barely-visible sliver. Common for "all time" on a
  // fresh install with only today's data.
  const singleBucket = buckets.length === 1;
  const barWidth = plotWidth * 0.3;
  const barX = left + plotWidth / 2 - barWidth / 2;

  // Hover dot per series sits at the TOP edge of that layer's own slice of
  // the stack at each bucket -- the one point on a filled, stacked shape
  // that unambiguously belongs to a single series rather than the
  // combined total underneath it.
  let points = '';
  let cumulative = buckets.map(() => 0);
  const layers = series.map((s) => {
    const nextCumulative = buckets.map((b, i) => cumulative[i] + (b[s.key] ?? 0));

    if (singleBucket) {
      const yTop = toY(nextCumulative[0]);
      const yBottom = toY(cumulative[0]);
      const rect = `<rect class="mlpr-chart-area" x="${barX.toFixed(1)}" y="${yTop.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${(yBottom - yTop).toFixed(1)}" fill="${s.color}" fill-opacity="0.7" />`;
      points += `<circle class="mlpr-chart-point" data-i="0" cx="${(barX + barWidth / 2).toFixed(1)}" cy="${yTop.toFixed(1)}" r="3" fill="${s.color}" />`;
      cumulative = nextCumulative;
      return rect;
    }

    const xs = buckets.map((b, i) => plotX(i, buckets.length, left, plotWidth));
    const topPoints = buckets.map((b, i) => `${xs[i].toFixed(1)},${toY(nextCumulative[i]).toFixed(1)}`);
    const bottomPoints = buckets.map((b, i) => `${xs[i].toFixed(1)},${toY(cumulative[i]).toFixed(1)}`).reverse();
    const polygon = `<polygon class="mlpr-chart-area" points="${[...topPoints, ...bottomPoints].join(' ')}" fill="${s.color}" fill-opacity="0.55" stroke="${s.color}" stroke-width="1" />`;
    points += buckets
      .map((b, i) => `<circle class="mlpr-chart-point" data-i="${i}" cx="${xs[i].toFixed(1)}" cy="${toY(nextCumulative[i]).toFixed(1)}" r="3" fill="${s.color}" />`)
      .join('');
    cumulative = nextCumulative;
    return polygon;
  });

  return `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" class="mlpr-chart">
    ${gridLinesSvg(left, top, plotWidth, plotHeight)}
    ${layers.join('')}
    ${cursorLinesSvg(buckets, left, plotWidth, top, plotHeight)}
    ${points}
    ${yAxisLabelsSvg(left, top, plotHeight, maxTotal, formatValue)}
    ${xAxisLabelsSvg(buckets, left, plotWidth, height - 4, formatBucket)}
    ${pointHitRegionsSvg(buckets, left, plotWidth, top, plotHeight)}
  </svg>`;
}

// Grouped bars: each bucket gets one bar per series, side by side.
export function renderBarChartSvg(
  buckets,
  series,
  { width = 560, height = 170, formatValue = defaultFormatValue, formatBucket = formatBucketLabel } = {},
) {
  if (buckets.length === 0) return emptyChartSvg(width, height);

  const left = PAD_LEFT;
  const top = PAD_TOP;
  const plotWidth = width - left - PAD_RIGHT;
  const plotHeight = height - top - PAD_BOTTOM;
  const maxValue = Math.max(1, ...buckets.flatMap((b) => series.map((s) => b[s.key] ?? 0)));
  const groupWidth = plotWidth / buckets.length;
  const barWidth = (groupWidth * 0.7) / series.length;

  const bars = buckets
    .flatMap((b, i) => {
      const groupX = left + i * groupWidth + groupWidth * 0.15;
      return series.map((s, si) => {
        const value = b[s.key] ?? 0;
        const barHeight = (value / maxValue) * plotHeight;
        const bx = groupX + si * barWidth;
        const by = top + plotHeight - barHeight;
        return `<rect class="mlpr-chart-bar" data-i="${i}" x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${(barWidth * 0.85).toFixed(1)}" height="${Math.max(0, barHeight).toFixed(1)}" fill="${s.color}" rx="1.5" />`;
      });
    })
    .join('');

  // One hit region per bucket's whole group column (not per bar) -- hovering
  // anywhere in a bucket's column, including the gaps between/around its
  // bars, should still target that bucket rather than requiring a precise
  // hit on a thin bar.
  const hitRegions = buckets
    .map((b, i) => {
      const x = left + i * groupWidth;
      return `<rect class="mlpr-chart-hit" data-i="${i}" x="${x.toFixed(1)}" y="${top.toFixed(1)}" width="${groupWidth.toFixed(1)}" height="${plotHeight.toFixed(1)}" />`;
    })
    .join('');

  return `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" class="mlpr-chart">
    ${gridLinesSvg(left, top, plotWidth, plotHeight)}
    ${bars}
    ${yAxisLabelsSvg(left, top, plotHeight, maxValue, formatValue)}
    ${xAxisLabelsSvg(buckets, left, plotWidth, height - 4, formatBucket)}
    ${hitRegions}
  </svg>`;
}

// items: [{ label, value }]. Slices beyond maxSlices are folded into a
// trailing "other" slice (labelled by the caller via otherLabel) so a long
// tail of rare types/airlines doesn't turn the doughnut into confetti.
//
// Each slice's <circle> carries class="mlpr-doughnut-slice" + data-i="N" --
// since the slice is drawn stroke-only (fill="none"), the browser's default
// SVG hit-testing (visiblePainted) already resolves pointer events to just
// the painted arc, not the whole circle's bounding area, so no separate
// hit-region geometry is needed the way the bucketed line/bar charts need
// pointHitRegionsSvg. stats.js's wireDoughnutTooltip reads data-i back off
// whatever slice a pointer event landed on, same shared-source-of-truth
// reasoning as every other chart's hover handling in this file.
//
// centerLabel/centerSublabel (both pre-formatted strings, not raw
// user-facing data -- callers only ever pass a formatted total count) render
// centered in the ring's open middle, giving the card's biggest visual
// element -- the circle itself -- something to say beyond decoration.
export function renderDoughnutSvg(
  items,
  { width = 200, height = 200, colors = DOUGHNUT_COLORS, maxSlices = 6, otherLabel = 'Other', centerLabel = null, centerSublabel = null } = {},
) {
  if (items.length === 0) return emptyChartSvg(width, height);

  const top = items.slice(0, maxSlices);
  const otherValue = items.slice(maxSlices).reduce((sum, i) => sum + i.value, 0);
  const slices = otherValue > 0 ? [...top, { label: otherLabel, value: otherValue }] : top;
  const total = slices.reduce((sum, s) => sum + s.value, 0) || 1;

  const radius = Math.min(width, height) / 2 - 10;
  const circumference = 2 * Math.PI * radius;
  const cx = width / 2;
  const cy = height / 2;

  let offset = 0;
  const arcs = slices
    .map((slice, i) => {
      const dash = (slice.value / total) * circumference;
      const circle = `<circle class="mlpr-doughnut-slice" data-i="${i}" cx="${cx}" cy="${cy}" r="${radius}" fill="none" stroke="${colors[i % colors.length]}" stroke-width="20" stroke-dasharray="${dash.toFixed(2)} ${(circumference - dash).toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(2)}" transform="rotate(-90 ${cx} ${cy})" />`;
      offset += dash;
      return circle;
    })
    .join('');

  const center = centerLabel
    ? `<text x="${cx}" y="${cy - (centerSublabel ? 6 : 0)}" text-anchor="middle" dominant-baseline="central" class="mlpr-doughnut-center-value">${centerLabel}</text>` +
      (centerSublabel ? `<text x="${cx}" y="${cy + 14}" text-anchor="middle" dominant-baseline="central" class="mlpr-doughnut-center-label">${centerSublabel}</text>` : '')
    : '';

  return `<svg viewBox="0 0 ${width} ${height}" class="mlpr-doughnut">${arcs}${center}</svg>`;
}

// Same slice-folding logic as renderDoughnutSvg, exposed separately so
// stats.js can build a legend (with the same colors, in the same order)
// without re-deriving the "other" bucket itself.
export function doughnutSlices(items, { maxSlices = 6, otherLabel = 'Other' } = {}) {
  const top = items.slice(0, maxSlices);
  const otherValue = items.slice(maxSlices).reduce((sum, i) => sum + i.value, 0);
  return otherValue > 0 ? [...top, { label: otherLabel, value: otherValue }] : top;
}

// items: [{ value }], one per wedge, in clockwise order starting from due
// north. Each wedge is drawn as a filled pie-wedge ("petal") reaching out
// to a radius proportional to its value -- the antenna "directional
// coverage" chart, showing at a glance which direction the receiver sees
// the farthest (and, just as usefully, which is shadowed by a building or
// hill). Concentric rings mark 25/50/75/100% of the max value; N/E/S/W
// labels orient the reader. This renderer doesn't care how many items it's
// given -- server/src/antenna-stats.js's SECTOR_COUNT (180, for the on-map
// coverage polygon's resolution) is far too many to render as legible
// individual petals here, so stats.js pre-aggregates down to a handful via
// mergeRoseSectors below before calling this.
export function renderRoseChartSvg(items, { width = 260, height = 260, color = '#3ddc84', formatValue = defaultFormatValue } = {}) {
  if (items.length === 0) return emptyChartSvg(width, height);

  const cx = width / 2;
  const cy = height / 2;
  const maxRadius = Math.min(width, height) / 2 - 22;
  const maxValue = Math.max(1, ...items.map((i) => i.value));
  const sectorAngle = (2 * Math.PI) / items.length;

  // Bearing 0 = north = straight up in screen space, clockwise.
  const point = (bearingRad, radius) => [cx + radius * Math.sin(bearingRad), cy - radius * Math.cos(bearingRad)];

  const largeArc = sectorAngle > Math.PI ? 1 : 0;

  const petals = items
    .map((item, i) => {
      const r = (Math.max(0, item.value) / maxValue) * maxRadius;
      if (r <= 0) return '';
      const startAngle = i * sectorAngle;
      const endAngle = (i + 1) * sectorAngle;
      const [x1, y1] = point(startAngle, r);
      const [x2, y2] = point(endAngle, r);
      return `<path class="mlpr-rose-petal" data-i="${i}" d="M ${cx.toFixed(1)} ${cy.toFixed(1)} L ${x1.toFixed(1)} ${y1.toFixed(1)} A ${r.toFixed(1)} ${r.toFixed(1)} 0 ${largeArc} 1 ${x2.toFixed(1)} ${y2.toFixed(1)} Z" fill="${color}" fill-opacity="0.55" stroke="${color}" stroke-width="1" />`;
    })
    .join('');

  // One full-radius, invisible hit region per wedge, drawn *after* (i.e. on
  // top of, in SVG paint order) the visible petals -- unlike those, this
  // always covers its wedge's full pie-slice regardless of the item's own
  // value, so a zero-value direction (nothing recorded there yet, no
  // visible petal at all -- see mergeRoseSectors) is still hoverable and
  // reports "0" rather than being a silent dead zone next to responsive
  // ones. Same "hit region separate from the visual mark" shape as every
  // other chart in this file (pointHitRegionsSvg, the doughnut's own
  // stroke-based slices), so stats.js's hover handling can stay one
  // consistent pattern.
  const hitRegions = items
    .map((item, i) => {
      const startAngle = i * sectorAngle;
      const endAngle = (i + 1) * sectorAngle;
      const [x1, y1] = point(startAngle, maxRadius);
      const [x2, y2] = point(endAngle, maxRadius);
      return `<path class="mlpr-rose-hit" data-i="${i}" d="M ${cx.toFixed(1)} ${cy.toFixed(1)} L ${x1.toFixed(1)} ${y1.toFixed(1)} A ${maxRadius.toFixed(1)} ${maxRadius.toFixed(1)} 0 ${largeArc} 1 ${x2.toFixed(1)} ${y2.toFixed(1)} Z" fill="transparent" />`;
    })
    .join('');

  const rings = [0.25, 0.5, 0.75, 1]
    .map((f) => `<circle cx="${cx}" cy="${cy}" r="${(maxRadius * f).toFixed(1)}" fill="none" stroke="#14212b" stroke-width="1" />`)
    .join('');

  const cardinals = [
    ['N', 0],
    ['E', Math.PI / 2],
    ['S', Math.PI],
    ['W', (3 * Math.PI) / 2],
  ]
    .map(([label, angle]) => {
      const [x, y] = point(angle, maxRadius + 12);
      return `<text x="${x.toFixed(1)}" y="${(y + 3).toFixed(1)}" fill="#5c7885" font-size="10" text-anchor="middle">${label}</text>`;
    })
    .join('');

  // Top-left corner, not centered above the ring -- centering it there would
  // collide with the "N" cardinal label, which sits in that same spot (top
  // center, just outside the outer ring).
  const maxLabel = `<text x="4" y="12" fill="#7fa3b3" font-size="9" text-anchor="start">${formatValue(maxValue)}</text>`;

  return `<svg viewBox="0 0 ${width} ${height}" class="mlpr-rose-chart">
    ${rings}
    ${petals}
    ${hitRegions}
    ${cardinals}
    ${maxLabel}
  </svg>`;
}

// Collapses a fine-grained sector array (server/src/antenna-stats.js's raw
// 180) down to groupCount wide wedges for renderRoseChartSvg, in the same
// clockwise-from-north order -- at full resolution the rose chart is
// dozens of near-invisible slivers that blur into visual noise; a handful
// of wide wedges reads as an actual shape.
//
// Sub-sectors with no recorded contact yet (value 0, antenna-stats.js's
// convention for "nothing here") are excluded from the average rather than
// counted as a real 0 -- most raw sub-sectors in any macro-wedge are still
// empty on a typical home receiver (SECTOR_COUNT=180 is intentionally fine
// enough that most individual slivers stay sparse for a long time, see
// CLAUDE.md), so blending those zeros in would drag a wedge's figure down
// to a fraction of what the receiver has actually demonstrated in that
// direction. A wedge with no populated sub-sector at all still reports 0,
// the same honest "no data here yet" signal a single empty sector already
// gives -- this only changes how zeros get diluted once other, real
// samples share the same wedge.
//
// Index-proportional grouping (`Math.floor(i * groupCount / items.length)`)
// rather than a fixed chunk size: works whether or not items.length divides
// evenly by groupCount, so this doesn't need revisiting if SECTOR_COUNT
// ever changes again.
export function mergeRoseSectors(items, groupCount) {
  if (groupCount <= 0 || items.length === 0) return [];

  const sums = new Array(groupCount).fill(0);
  const counts = new Array(groupCount).fill(0);
  items.forEach((item, i) => {
    const group = Math.min(groupCount - 1, Math.floor((i * groupCount) / items.length));
    if (item.value > 0) {
      sums[group] += item.value;
      counts[group] += 1;
    }
  });

  return sums.map((sum, i) => ({ value: counts[i] > 0 ? sum / counts[i] : 0 }));
}

export function renderSparklineSvg(values, { width = 280, height = 48, color = '#3ddc84' } = {}) {
  if (values.length < 2) {
    return `<svg viewBox="0 0 ${width} ${height}" class="mlpr-sparkline"></svg>`;
  }

  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;

  const points = values
    .map((value, i) => {
      const x = (i / (values.length - 1)) * width;
      const y = height - ((value - min) / range) * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  return `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" class="mlpr-sparkline">
    <polyline points="${points}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
  </svg>`;
}
