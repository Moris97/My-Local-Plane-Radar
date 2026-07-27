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

import { colorFromStops } from './color-gradient.js';

const ALTITUDE_STOPS = [
  // 0-10,000 ft used to be two identical greens (a flat, uninformative
  // band) -- most locally-tracked traffic (circuit, approach, departure)
  // spends its whole visible life in exactly this range, so it's the band
  // that most needs a gradient. Shifted into a golden-green at ground level
  // via lerpSpace 'hsl' (a pure hue sweep, not a lightness one, so it stays
  // exactly as vivid as the rest of the scale rather than looking dim/muddy
  // at ground level).
  { at: 0, color: [210, 196, 30] }, // golden green (ground)
  { at: 10000, color: [61, 220, 132], lerpSpace: 'hsl' }, // green
  // Green and this blue share the exact same saturation/lightness (only the
  // hue differs, ~147deg -> ~210deg) -- a straight per-channel RGB lerp
  // between them doesn't preserve that, so the perceived color barely
  // shifts for most of the band and only looks distinctly non-green near
  // the very top of it. lerpSpace 'hsl' rotates the hue directly instead,
  // so the shift away from green is visible early in the band, not just at
  // the top (reported: a plane at ~4900 m/16,000 ft still looked pure
  // green, only became visibly non-green around 6,000 m/20,000 ft).
  { at: 17500, color: [61, 140, 220], lerpSpace: 'hsl' }, // blue
  // Same problem as the leg above, and worse: an RGB lerp straight from
  // this blue to the dark red below passes through desaturated mud -- e.g.
  // at the old 35,000 ft stop it produced rgb(92,57,83), a washed-out
  // grey-maroon, right around typical cruise altitude, so most airliner
  // trails came out in a muddy near-grey that was hard to tell apart from
  // the grey no-contact colour (reported as "the grey goes slightly red on
  // the dark map"). Rotating hue in HSL instead keeps saturation up the
  // whole way, so the band sweeps blue -> violet -> magenta -> red and
  // every few thousand feet is a visibly different colour. Pure red lands
  // at 30,250 ft (not right after blue) deliberately, so there's a long,
  // gradually-darkening red tail from there to 40,000 ft -- the altitude
  // band most cruise traffic actually sits in -- rather than everything
  // above ~30k being one indistinguishable dark red.
  { at: 30250, color: [224, 49, 49], lerpSpace: 'hsl' }, // red
  // Red -> dark red is a pure lightness change at the same hue, so a plain
  // RGB lerp is correct (and an HSL one would be identical anyway).
  { at: 40000, color: [107, 15, 15] }, // dark red
];

export function colorForAltitude(altitudeFt) {
  const alt = typeof altitudeFt === 'number' ? altitudeFt : 0;
  return colorFromStops(ALTITUDE_STOPS, alt);
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
