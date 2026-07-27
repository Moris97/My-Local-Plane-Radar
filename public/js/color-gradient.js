// Shared multi-stop gradient interpolation, used by both the trail altitude
// gradient (trail.js) and the aircraft marker color modes (aircraft-color.js)
// -- extracted here instead of duplicated a third time. See trail.js's
// ALTITUDE_STOPS comments for why HSL interpolation matters: a plain RGB
// lerp between two colors of different hue *and* lightness passes through
// desaturated mud (a real bug found and fixed there).

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function lerpColorRgb(c1, c2, t) {
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

// stops: ascending-sorted [{ at: number, color: [r,g,b], lerpSpace?: 'hsl' }].
// lerpSpace on a stop governs the leg leading *into* that stop from the
// previous one; the first stop's lerpSpace is never read. Values below the
// first stop or above the last one clamp to that stop's color.
export function colorFromStops(stops, value) {
  if (value <= stops[0].at) return `rgb(${stops[0].color.join(',')})`;
  for (let i = 0; i < stops.length - 1; i += 1) {
    const a = stops[i];
    const b = stops[i + 1];
    if (value <= b.at) {
      const t = (value - a.at) / (b.at - a.at);
      const color = b.lerpSpace === 'hsl' ? lerpColorHsl(a.color, b.color, t) : lerpColorRgb(a.color, b.color, t);
      return `rgb(${color.join(',')})`;
    }
  }
  const last = stops[stops.length - 1];
  return `rgb(${last.color.join(',')})`;
}
