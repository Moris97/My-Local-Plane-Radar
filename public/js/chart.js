export const DOUGHNUT_COLORS = ['#3ddc84', '#3d8bdc', '#dc9d3d', '#a83ddc', '#dc3d5e', '#3ddcc4', '#8a8a8a'];

const PAD_TOP = 16;
const PAD_RIGHT = 10;
const PAD_BOTTOM = 18;
const PAD_LEFT = 46;

function emptyChartSvg(width, height) {
  return `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" class="mlpr-chart"></svg>`;
}

function defaultFormatValue(value) {
  return String(Math.round(value));
}

// Bucket keys come straight from server/src/time-buckets.js's bucketKey():
// "YYYY-MM-DDTHH" (hour), "YYYY-MM-DD" (day), "YYYY-Www" (ISO week), or
// "YYYY-MM" (month). Used for the chart's X-axis start/end labels.
export function formatBucketLabel(key) {
  if (typeof key !== 'string') return '';
  const hourMatch = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})$/.exec(key);
  if (hourMatch) {
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

  const polylines = series
    .map((s) => {
      const coords = buckets.map((b, i) => [
        plotX(i, buckets.length, left, plotWidth),
        top + plotHeight - ((b[s.key] ?? 0) / maxValue) * plotHeight,
      ]);
      const points = coords.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
      // A single point produces an invisible polyline (needs >=2 points to
      // draw a segment) -- always common for "all time" on a fresh install
      // with only today's data. Draw it as a dot instead of silently
      // showing nothing.
      if (coords.length === 1) {
        const [x, y] = coords[0];
        return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3" fill="${s.color}" />`;
      }
      return `<polyline points="${points}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />`;
    })
    .join('');

  return `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" class="mlpr-chart">
    ${gridLinesSvg(left, top, plotWidth, plotHeight)}
    ${polylines}
    ${yAxisLabelsSvg(left, top, plotHeight, maxValue, formatValue)}
    ${xAxisLabelsSvg(buckets, left, plotWidth, height - 4, formatBucket)}
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

  let cumulative = buckets.map(() => 0);
  const layers = series.map((s) => {
    const nextCumulative = buckets.map((b, i) => cumulative[i] + (b[s.key] ?? 0));

    if (singleBucket) {
      const yTop = toY(nextCumulative[0]);
      const yBottom = toY(cumulative[0]);
      const rect = `<rect x="${barX.toFixed(1)}" y="${yTop.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${(yBottom - yTop).toFixed(1)}" fill="${s.color}" fill-opacity="0.7" />`;
      cumulative = nextCumulative;
      return rect;
    }

    const topPoints = buckets.map((b, i) => `${plotX(i, buckets.length, left, plotWidth).toFixed(1)},${toY(nextCumulative[i]).toFixed(1)}`);
    const bottomPoints = buckets
      .map((b, i) => `${plotX(i, buckets.length, left, plotWidth).toFixed(1)},${toY(cumulative[i]).toFixed(1)}`)
      .reverse();
    const polygon = `<polygon points="${[...topPoints, ...bottomPoints].join(' ')}" fill="${s.color}" fill-opacity="0.55" stroke="${s.color}" stroke-width="1" />`;
    cumulative = nextCumulative;
    return polygon;
  });

  return `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" class="mlpr-chart">
    ${gridLinesSvg(left, top, plotWidth, plotHeight)}
    ${layers.join('')}
    ${yAxisLabelsSvg(left, top, plotHeight, maxTotal, formatValue)}
    ${xAxisLabelsSvg(buckets, left, plotWidth, height - 4, formatBucket)}
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
        return `<rect x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${(barWidth * 0.85).toFixed(1)}" height="${Math.max(0, barHeight).toFixed(1)}" fill="${s.color}" rx="1.5" />`;
      });
    })
    .join('');

  return `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" class="mlpr-chart">
    ${gridLinesSvg(left, top, plotWidth, plotHeight)}
    ${bars}
    ${yAxisLabelsSvg(left, top, plotHeight, maxValue, formatValue)}
    ${xAxisLabelsSvg(buckets, left, plotWidth, height - 4, formatBucket)}
  </svg>`;
}

// items: [{ label, value }]. Slices beyond maxSlices are folded into a
// trailing "other" slice (labelled by the caller via otherLabel) so a long
// tail of rare types/airlines doesn't turn the doughnut into confetti.
export function renderDoughnutSvg(items, { width = 200, height = 200, colors = DOUGHNUT_COLORS, maxSlices = 6, otherLabel = 'Other' } = {}) {
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
      const circle = `<circle cx="${cx}" cy="${cy}" r="${radius}" fill="none" stroke="${colors[i % colors.length]}" stroke-width="20" stroke-dasharray="${dash.toFixed(2)} ${(circumference - dash).toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(2)}" transform="rotate(-90 ${cx} ${cy})" />`;
      offset += dash;
      return circle;
    })
    .join('');

  return `<svg viewBox="0 0 ${width} ${height}" class="mlpr-doughnut">${arcs}</svg>`;
}

// Same slice-folding logic as renderDoughnutSvg, exposed separately so
// stats.js can build a legend (with the same colors, in the same order)
// without re-deriving the "other" bucket itself.
export function doughnutSlices(items, { maxSlices = 6, otherLabel = 'Other' } = {}) {
  const top = items.slice(0, maxSlices);
  const otherValue = items.slice(maxSlices).reduce((sum, i) => sum + i.value, 0);
  return otherValue > 0 ? [...top, { label: otherLabel, value: otherValue }] : top;
}

// items: [{ label, value }], one per compass sector (typically 16, see
// antenna-stats.js's SECTOR_LABELS), in clockwise order starting from due
// north. Each sector is drawn as a filled pie-wedge ("petal") reaching out
// to a radius proportional to its value -- the antenna "directional
// coverage" chart, showing at a glance which direction the receiver sees
// the farthest (and, just as usefully, which is shadowed by a building or
// hill). Concentric rings mark 25/50/75/100% of the max value; N/E/S/W
// labels orient the reader (a 16-point rose with every label would be
// unreadably cluttered, so only the four cardinals are drawn).
export function renderRoseChartSvg(items, { width = 260, height = 260, color = '#3ddc84', formatValue = defaultFormatValue } = {}) {
  if (items.length === 0) return emptyChartSvg(width, height);

  const cx = width / 2;
  const cy = height / 2;
  const maxRadius = Math.min(width, height) / 2 - 22;
  const maxValue = Math.max(1, ...items.map((i) => i.value));
  const sectorAngle = (2 * Math.PI) / items.length;

  // Bearing 0 = north = straight up in screen space, clockwise.
  const point = (bearingRad, radius) => [cx + radius * Math.sin(bearingRad), cy - radius * Math.cos(bearingRad)];

  const petals = items
    .map((item, i) => {
      const r = (Math.max(0, item.value) / maxValue) * maxRadius;
      if (r <= 0) return '';
      const startAngle = i * sectorAngle;
      const endAngle = (i + 1) * sectorAngle;
      const [x1, y1] = point(startAngle, r);
      const [x2, y2] = point(endAngle, r);
      const largeArc = sectorAngle > Math.PI ? 1 : 0;
      return `<path d="M ${cx.toFixed(1)} ${cy.toFixed(1)} L ${x1.toFixed(1)} ${y1.toFixed(1)} A ${r.toFixed(1)} ${r.toFixed(1)} 0 ${largeArc} 1 ${x2.toFixed(1)} ${y2.toFixed(1)} Z" fill="${color}" fill-opacity="0.55" stroke="${color}" stroke-width="1" />`;
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
    ${cardinals}
    ${maxLabel}
  </svg>`;
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
