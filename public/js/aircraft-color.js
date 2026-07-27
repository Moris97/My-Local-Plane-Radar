// Pure aircraft-marker color logic, kept separate from app.js (which
// instantiates maplibregl.Map at module scope and can't be loaded under
// plain `node --test`) so it's unit-testable the same way trail.js's
// colorForAltitude is.
import { colorFromStops } from './color-gradient.js';

const FRESH_COLOR = [61, 220, 132]; // #3ddc84
const STALE_COLOR = [224, 49, 49]; // #e03131

// "Signal loss" mode: fades from fresh green to stale red as time passes
// since the last update. Unrelated to altitude/speed -- this is the only
// mode that reflects data freshness rather than a flight parameter.
export function colorForElapsed(elapsedMs, fadeStartMs, fadeEndMs) {
  if (elapsedMs <= fadeStartMs) {
    return `rgb(${FRESH_COLOR.join(',')})`;
  }
  const t = Math.min(1, (elapsedMs - fadeStartMs) / (fadeEndMs - fadeStartMs));
  const color = [0, 1, 2].map((i) => Math.round(FRESH_COLOR[i] + (STALE_COLOR[i] - FRESH_COLOR[i]) * t));
  return `rgb(${color.join(',')})`;
}

// Ground speed in knots -- green (slow/taxi) through yellow and orange to
// red (fast jet cruise), all legs in HSL so saturation stays high the whole
// way (same reasoning as trail.js's altitude gradient: a plain RGB lerp
// between hues this different passes through desaturated mud). Deliberately
// never touches blue/violet, unlike the altitude gradient, so the two modes
// don't look like variations on the same scale.
const SPEED_STOPS = [
  { at: 0, color: [61, 220, 132] }, // green (taxi/hover)
  { at: 120, color: [210, 196, 30], lerpSpace: 'hsl' }, // yellow (GA cruise)
  { at: 250, color: [224, 140, 30], lerpSpace: 'hsl' }, // orange (turboprop/approach)
  { at: 450, color: [224, 49, 49], lerpSpace: 'hsl' }, // red (jet cruise and above)
];

export function colorForSpeed(speedKt) {
  const kt = typeof speedKt === 'number' ? speedKt : 0;
  return colorFromStops(SPEED_STOPS, kt);
}
