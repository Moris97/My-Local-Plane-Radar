// Matches the server-side cap in server/src/trail-history.js. The "shorter
// trails" performance setting (settings-state.js's shorterTrails) lowers
// this at runtime via setShorterTrails -- see app.js's settings-change
// handler -- so a weaker device can trade trail length for less GeoJSON to
// render, without touching how much history the server itself retains.
const DEFAULT_MAX_HISTORY_POINTS = 1000;
const SHORT_MAX_HISTORY_POINTS = 200;
const GAP_COLOR = '#888a8f';

let maxHistoryPoints = DEFAULT_MAX_HISTORY_POINTS;

const history = new Map(); // hex -> [{ lngLat, alt, t, isGap }]

export function setShorterTrails(enabled) {
  maxHistoryPoints = enabled ? SHORT_MAX_HISTORY_POINTS : DEFAULT_MAX_HISTORY_POINTS;
}

const ALTITUDE_STOPS = [
  { ft: 0, color: [61, 220, 132] }, // green
  { ft: 10000, color: [61, 220, 132] },
  // Green and this blue share the exact same saturation/lightness (only the
  // hue differs, ~147deg -> ~210deg) -- a straight per-channel RGB lerp
  // between them doesn't preserve that, so the perceived color barely
  // shifts for most of the band and only looks distinctly non-green near
  // the very top of it. lerpSpace 'hsl' rotates the hue directly instead,
  // so the shift away from green is visible early in the band, not just at
  // the top (reported: a plane at ~4900 m/16,000 ft still looked pure
  // green, only became visibly non-green around 6,000 m/20,000 ft).
  { ft: 25000, color: [61, 140, 220], lerpSpace: 'hsl' }, // blue
  // Same problem as the leg above, and worse: an RGB lerp straight from
  // this blue to the dark red below passes through desaturated mud -- at
  // 35,000 ft it produced rgb(92,57,83), a washed-out grey-maroon. That is
  // exactly typical cruise altitude, so most airliner trails came out in a
  // muddy near-grey that was hard to tell apart from the grey no-contact
  // colour (reported as "the grey goes slightly red on the dark map").
  // Rotating hue in HSL instead keeps saturation up the whole way, so the
  // band sweeps blue -> violet -> magenta -> red and every few thousand
  // feet is a visibly different colour.
  { ft: 36000, color: [224, 49, 49], lerpSpace: 'hsl' }, // red
  // Red -> dark red is a pure lightness change at the same hue, so a plain
  // RGB lerp is correct (and an HSL one would be identical anyway).
  { ft: 40000, color: [107, 15, 15] }, // dark red
];

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function lerpColor(c1, c2, t) {
  return [
    Math.round(lerp(c1[0], c2[0], t)),
    Math.round(lerp(c1[1], c2[1], t)),
    Math.round(lerp(c1[2], c2[2], t)),
  ];
}

function rgbToHsl([r, g, b]) {
  const rf = r / 255;
  const gf = g / 255;
  const bf = b / 255;
  const max = Math.max(rf, gf, bf);
  const min = Math.min(rf, gf, bf);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === rf) h = (gf - bf) / d + (gf < bf ? 6 : 0);
  else if (max === gf) h = (bf - rf) / d + 2;
  else h = (rf - gf) / d + 4;
  return [h * 60, s, l];
}

function hslToRgb([h, s, l]) {
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hk = (((h % 360) + 360) % 360) / 360;
  const channel = (shift) => {
    let x = hk + shift;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  return [channel(1 / 3), channel(0), channel(-1 / 3)].map((v) => Math.round(v * 255));
}

// Shortest-arc hue interpolation (e.g. 350deg -> 10deg goes forward through
// 360/0, not backward through 180) so a hue-space lerp never takes an
// unnecessarily long way around the color wheel.
function lerpHue(h1, h2, t) {
  let diff = h2 - h1;
  if (diff > 180) diff -= 360;
  if (diff < -180) diff += 360;
  return ((h1 + diff * t + 360) % 360);
}

function lerpColorHsl(c1, c2, t) {
  const [h1, s1, l1] = rgbToHsl(c1);
  const [h2, s2, l2] = rgbToHsl(c2);
  return hslToRgb([lerpHue(h1, h2, t), lerp(s1, s2, t), lerp(l1, l2, t)]);
}

export function colorForAltitude(altitudeFt) {
  const alt = typeof altitudeFt === 'number' ? altitudeFt : 0;

  if (alt <= ALTITUDE_STOPS[0].ft) {
    return `rgb(${ALTITUDE_STOPS[0].color.join(',')})`;
  }

  for (let i = 0; i < ALTITUDE_STOPS.length - 1; i += 1) {
    const a = ALTITUDE_STOPS[i];
    const b = ALTITUDE_STOPS[i + 1];
    if (alt <= b.ft) {
      const t = (alt - a.ft) / (b.ft - a.ft);
      const color = b.lerpSpace === 'hsl' ? lerpColorHsl(a.color, b.color, t) : lerpColor(a.color, b.color, t);
      return `rgb(${color.join(',')})`;
    }
  }

  const last = ALTITUDE_STOPS[ALTITUDE_STOPS.length - 1];
  return `rgb(${last.color.join(',')})`;
}

export function seedHistory(hex, serverPoints) {
  const points = serverPoints.map((point) => ({
    lngLat: [point.lon, point.lat],
    alt: point.onGround ? 0 : point.altBaro,
    t: point.t,
    isGap: false,
  }));
  if (points.length > maxHistoryPoints) {
    points.splice(0, points.length - maxHistoryPoints);
  }
  history.set(hex, points);
}

export function recordPosition(hex, lngLat, altitudeFt, timestamp, isGap = false) {
  let points = history.get(hex);
  if (!points) {
    points = [];
    history.set(hex, points);
  }
  points.push({ lngLat, alt: altitudeFt, t: timestamp, isGap });
  if (points.length > maxHistoryPoints) {
    points.splice(0, points.length - maxHistoryPoints);
  }
}

export function getHistory(hex) {
  return history.get(hex) ?? [];
}

export function clearHistory(hex) {
  history.delete(hex);
}

// Altitude is quantised into bands before picking a color purely so that
// consecutive segments at a steady altitude come out byte-identical and can
// be merged into one polyline below. 200 ft out of the 0-40,000 ft range is
// ~200 distinct colors -- far finer than the eye resolves on a 3.5px line,
// so the gradient still reads as smooth.
const ALTITUDE_BAND_FT = 200;

function bandedColor(alt) {
  if (typeof alt !== 'number') return colorForAltitude(alt);
  return colorForAltitude(Math.round(alt / ALTITUDE_BAND_FT) * ALTITUDE_BAND_FT);
}

// Consecutive segments sharing a color (and gap-ness) are emitted as a
// single multi-point LineString rather than one 2-point feature each.
// Two reasons, both about the "trail looks dashed when zoomed out" report:
// every feature boundary is a seam that antialiasing can show as a hairline
// when the segment is only a few pixels long at low zoom, and thousands of
// tiny features are also just more work to render. At a steady cruise
// altitude this collapses an entire trail into one polyline. Gap segments
// are never merged into a colored run -- they are drawn by their own dashed
// layer (see app.js) and must stay separate features.
export function trailFeaturesFor(hex) {
  const points = getHistory(hex);
  const features = [];
  let run = null;

  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    const isGap = Boolean(b.isGap);
    const color = isGap ? GAP_COLOR : bandedColor(b.alt);

    if (run && !isGap && !run.properties.isGap && run.properties.color === color) {
      run.geometry.coordinates.push(b.lngLat);
      continue;
    }

    run = {
      type: 'Feature',
      properties: { color, isGap },
      geometry: { type: 'LineString', coordinates: [a.lngLat, b.lngLat] },
    };
    features.push(run);
  }

  return features;
}
