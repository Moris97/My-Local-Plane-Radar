const MAX_HISTORY_POINTS = 300;
const GAP_COLOR = '#888a8f';

const history = new Map(); // hex -> [{ lngLat, alt, t, isGap }]

const ALTITUDE_STOPS = [
  { ft: 0, color: [61, 220, 132] }, // green
  { ft: 10000, color: [61, 220, 132] },
  { ft: 25000, color: [61, 140, 220] }, // blue
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
      return `rgb(${lerpColor(a.color, b.color, t).join(',')})`;
    }
  }

  const last = ALTITUDE_STOPS[ALTITUDE_STOPS.length - 1];
  return `rgb(${last.color.join(',')})`;
}

export function seedHistory(hex, serverPoints) {
  history.set(
    hex,
    serverPoints.map((point) => ({
      lngLat: [point.lon, point.lat],
      alt: point.onGround ? 0 : point.altBaro,
      t: point.t,
      isGap: false,
    })),
  );
}

export function recordPosition(hex, lngLat, altitudeFt, timestamp, isGap = false) {
  let points = history.get(hex);
  if (!points) {
    points = [];
    history.set(hex, points);
  }
  points.push({ lngLat, alt: altitudeFt, t: timestamp, isGap });
  if (points.length > MAX_HISTORY_POINTS) {
    points.splice(0, points.length - MAX_HISTORY_POINTS);
  }
}

export function getHistory(hex) {
  return history.get(hex) ?? [];
}

export function clearHistory(hex) {
  history.delete(hex);
}

export function trailFeaturesFor(hex) {
  const points = getHistory(hex);
  const features = [];
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    features.push({
      type: 'Feature',
      properties: { color: b.isGap ? GAP_COLOR : colorForAltitude(b.alt) },
      geometry: { type: 'LineString', coordinates: [a.lngLat, b.lngLat] },
    });
  }
  return features;
}
