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
import { distanceKm, bearingDegrees } from './geo.js';

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
    isMlat: point.sourceType === 'mlat',
  }));
  if (points.length > maxHistoryPoints) {
    points.splice(0, points.length - maxHistoryPoints);
  }
  history.set(hex, points);
}

export function recordPosition(hex, lngLat, altitudeFt, timestamp, isGap = false, sourceType = undefined) {
  let points = history.get(hex);
  if (!points) {
    points = [];
    history.set(hex, points);
  }
  points.push({ lngLat, alt: altitudeFt, t: timestamp, isGap, isMlat: sourceType === 'mlat' });
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

// MLAT positions are computed from several receivers' message timing, not
// measured directly -- they can jump in ways a real aircraft never would
// (jagged zigzags, false sharp turns), especially with weak receiver
// geometry. ADS-B positions are broadcast directly by the aircraft and are
// never touched by either pass below, regardless of how implausible a
// *neighboring* MLAT point looks.
const MLAT_MAX_SPEED_KMH = 2200; // ~1200 kt -- well above anything real, only catches multi-hundred-km jumps
const MLAT_MAX_TURN_RATE_DEG_PER_SEC = 10; // a "standard rate" airliner turn is ~3deg/s; even a hard fighter break is well under this
// Below this, two points are close enough together that GPS/MLAT-scale
// positional noise alone can imply a huge bearing swing between them for no
// real reason -- the turn-rate check is skipped for such short segments
// (the speed check above still applies to them).
const MLAT_MIN_TURN_CHECK_KM = 0.3;

function impliedSpeedKmh(a, b) {
  const dtHours = (b.t - a.t) / 3_600_000;
  if (dtHours <= 0) return Infinity; // same/earlier timestamp than its predecessor can't be a real sample
  return distanceKm(a.lngLat[1], a.lngLat[0], b.lngLat[1], b.lngLat[0]) / dtHours;
}

function angleDiffDeg(a, b) {
  const diff = Math.abs(a - b) % 360;
  return diff > 180 ? 360 - diff : diff;
}

// prevAccepted/lastAccepted are the two most recent *accepted* points (real
// ADS-B, or MLAT that already passed this same check) -- judging against
// the last accepted point rather than the raw previous point means a run of
// several bad MLAT samples in a row doesn't each get compared against an
// already-rejected neighbor.
function isAnomalousMlatPoint(prevAccepted, lastAccepted, candidate) {
  if (impliedSpeedKmh(lastAccepted, candidate) > MLAT_MAX_SPEED_KMH) return true;
  if (!prevAccepted) return false; // no established heading yet to judge a turn against

  const incomingKm = distanceKm(prevAccepted.lngLat[1], prevAccepted.lngLat[0], lastAccepted.lngLat[1], lastAccepted.lngLat[0]);
  const outgoingKm = distanceKm(lastAccepted.lngLat[1], lastAccepted.lngLat[0], candidate.lngLat[1], candidate.lngLat[0]);
  if (incomingKm < MLAT_MIN_TURN_CHECK_KM || outgoingKm < MLAT_MIN_TURN_CHECK_KM) return false;

  const dtSeconds = (candidate.t - lastAccepted.t) / 1000;
  if (dtSeconds <= 0) return true;

  const incomingBearing = bearingDegrees(prevAccepted.lngLat[1], prevAccepted.lngLat[0], lastAccepted.lngLat[1], lastAccepted.lngLat[0]);
  const outgoingBearing = bearingDegrees(lastAccepted.lngLat[1], lastAccepted.lngLat[0], candidate.lngLat[1], candidate.lngLat[0]);
  const turnRateDegPerSec = angleDiffDeg(incomingBearing, outgoingBearing) / dtSeconds;
  return turnRateDegPerSec > MLAT_MAX_TURN_RATE_DEG_PER_SEC;
}

// Streaming pass, oldest to newest: an ADS-B point or a gap marker is always
// kept outright and becomes the new reference; an MLAT point is judged
// against the two most recent *accepted* points and dropped from the
// rendered trail entirely if it fails (rather than kept but flagged --
// there's no useful way to draw "this position is probably wrong").
export function filterMlatAnomalies(points) {
  const kept = [];
  let prevAccepted = null;
  let lastAccepted = null;

  for (const point of points) {
    if (point.isGap || !point.isMlat || !lastAccepted) {
      kept.push(point);
      prevAccepted = lastAccepted;
      lastAccepted = point;
      continue;
    }

    if (isAnomalousMlatPoint(prevAccepted, lastAccepted, point)) continue;

    kept.push(point);
    prevAccepted = lastAccepted;
    lastAccepted = point;
  }

  return kept;
}

// Light positional smoothing for whatever MLAT points survive the anomaly
// filter above -- a simple weighted 3-point moving average
// (prev + 2*point + next) / 4, blending each MLAT point slightly toward its
// immediate neighbors. Only ever *moves* an MLAT point; ADS-B points are
// never modified, though they do still act as trustworthy anchors for an
// adjacent MLAT point's average. Skipped at either end of a trail, or next
// to a gap, where there's only one real neighbor to blend with.
export function smoothMlatPositions(points) {
  return points.map((point, i) => {
    if (!point.isMlat || point.isGap) return point;
    const prev = points[i - 1];
    const next = points[i + 1];
    if (!prev || !next || prev.isGap || next.isGap) return point;

    return {
      ...point,
      lngLat: [(prev.lngLat[0] + 2 * point.lngLat[0] + next.lngLat[0]) / 4, (prev.lngLat[1] + 2 * point.lngLat[1] + next.lngLat[1]) / 4],
    };
  });
}

// A live position update can arrive with no barometric altitude even
// mid-flight -- a weak/fringe decode can drop the altitude subfield while
// lat/lon still checksum, often right as an aircraft is about to lose
// contact entirely (reported live: a solid golden-green "ground level" trail
// segment appearing right where an aircraft was fading out, not a dashed
// gap). recordPosition/seedHistory store exactly what was received,
// undefined included -- bandedColor's fallback treats a non-number
// altitude as ground (colorForAltitude's own contract, correct for a
// contact with no altitude at all, e.g. Mode-S-only). Carrying the last
// known altitude forward here, at render time only, never touching stored
// history, keeps that fallback honest for its real use case instead of
// misrepresenting a fleeting missing-field tick as a dive to the ground. A
// no-op whenever every point already has a real altitude (the common case).
function carryForwardAltitude(points) {
  let lastKnownAlt = null;
  return points.map((point) => {
    if (typeof point.alt === 'number') {
      lastKnownAlt = point.alt;
      return point;
    }
    if (lastKnownAlt === null) return point; // no prior altitude to carry forward yet (e.g. trail start)
    return { ...point, alt: lastKnownAlt };
  });
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
  // All three passes are no-ops on a trail with no MLAT points and no
  // missing altitudes (the overwhelming common case -- most installs see
  // ADS-B for the vast majority of traffic), and cheap even on a full
  // 1000-point trail, so there's no need to cache the result or gate this
  // on trailMode/whether MLAT is actually present.
  const points = smoothMlatPositions(filterMlatAnomalies(carryForwardAltitude(getHistory(hex))));
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
