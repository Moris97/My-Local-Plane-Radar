// The new (v2) aircraft icon set -- 16 classified silhouettes plus one
// non-aircraft extra ('tower', a ground-station beacon, kept outside the
// spec'd 16 since it isn't really an "aircraft type"). This module is
// standalone and NOT yet wired into app.js/the live map -- see TODO.md and
// CLAUDE.md for why (icon set + classification are being built and reviewed
// in isolation first, on /dev/icons, before any live-map change).
//
// Hard rules every shape here follows (see the icon-set task write-up):
// - One <path> per icon, `fill="currentColor"` (no baked-in color) -- the
//   map layer decides color (signal loss / altitude / speed), never the
//   icon itself.
// - One shared viewBox (VIEW_BOX below), nose pointing up (track 0 =
//   north), so a plain CSS `rotate(trackDeg)` on the wrapping <svg> is
//   always correct.
// - One shared rotation/scale center across every icon: every shape keeps
//   its own wing-root / center-of-gravity band straddling y=12 (half of a
//   24-tall viewBox), with the nose extending toward y=0 and the tail
//   toward y=24. Combined with `transform-origin: center center` on the
//   <svg> (style.css), this is what keeps every icon anchored to the same
//   point when it scales or rotates -- get this wrong and icons visibly
//   drift off their marker position as the size slider moves.
// - Differences between the three widebody sizes are carried by fuselage
//   length/wing span proportion (widebody3 additionally gets a small
//   tail-mounted third-engine bump -- an accurate trijet silhouette cue,
//   not "counting nacelles"; widebody4 gets a nose hump, the 747
//   upper-deck cue) -- deliberately NOT by drawing more wing-mounted engine
//   blobs, which stops reading as anything at 14px.
//
// First draft of the fixed-wing shapes drew the fuselage and wing as two
// separate crossing polygons (mirroring the old aircraft-icon.js's
// technique). Rendered small, that reads as a plain "+"/"x" -- a thin rod
// crossed by a thin flat wing genuinely IS a plus sign, not an optical
// illusion, and every fixed-wing icon ended up visually indistinguishable
// from every other one. Every fixed-wing silhouette below is instead ONE
// continuous outline (nose -> wingtip -> tail -> mirrored back to nose),
// built by `wingedOutline()`/`symmetricOutline()` -- a solid dart/delta
// shape, which is what every real minimal top-down airplane glyph actually
// is. A single <path> can still hold multiple "M ... Z" subpaths for the
// handful of icons that layer on a small extra cue (widebody3's tail
// engine, widebody4's nose hump, special's dorsal disc) -- those
// embellishments are wound the same direction as the main outline
// (poly()'s point order is consistently nose-side-first/clockwise
// throughout this file) so they union with it under the default nonzero
// fill rule instead of any risk of cancelling out as a hole.

export const VIEW_BOX = '0 0 24 24';
const CENTER_X = 12;

function poly(points) {
  const [first, ...rest] = points;
  return `M${first[0]},${first[1]} ${rest.map(([x, y]) => `L${x},${y}`).join(' ')} Z`;
}

// Approximates a filled circle/ellipse as two arcs -- <path> has no native
// circle primitive.
function ellipse(cx, cy, rx, ry) {
  return `M${cx - rx},${cy} a${rx},${ry} 0 1,0 ${rx * 2},0 a${rx},${ry} 0 1,0 ${-rx * 2},0 Z`;
}

function combine(...parts) {
  return parts.join(' ');
}

// Mirrors a "right half" point list (all x >= CENTER_X, first and last
// points ON the centerline) across x=12 and closes it into one polygon --
// nose down the right side, across the tail, back up the mirrored left
// side. This is what keeps every fixed-wing icon a single solid outline
// instead of separate overlapping parts.
function symmetricOutline(rightPoints) {
  const middle = rightPoints.slice(1, -1);
  const left = middle.slice().reverse().map(([x, y]) => [2 * CENTER_X - x, y]);
  return poly([...rightPoints, ...left]);
}

// A generic winged-airframe outline: nose -> shoulder -> wingtip -> wing
// trailing edge back at the fuselage -> rear fuselage -> tailplane tip ->
// tail trailing edge -> tail tip. `wingFrontY`/`wingBackY` control sweep
// (far apart = swept back, equal = a straight/unswept wing).
function wingedOutline({
  noseY, fuseHalfWidth, wingFrontY, wingHalfSpan, wingBackY,
  tailFuseHalfWidth = fuseHalfWidth, tailHalfSpan, tailY, tailTipY,
}) {
  const wingY = (wingFrontY + wingBackY) / 2;
  return symmetricOutline([
    [CENTER_X, noseY],
    [CENTER_X + fuseHalfWidth, wingFrontY],
    [CENTER_X + wingHalfSpan, wingY],
    [CENTER_X + fuseHalfWidth, wingBackY],
    [CENTER_X + tailFuseHalfWidth, tailY - 3],
    [CENTER_X + tailHalfSpan, tailY],
    [CENTER_X + tailFuseHalfWidth * 0.5, tailY + 0.8],
    [CENTER_X, tailTipY],
  ]);
}

const narrowbodyPath = wingedOutline({
  noseY: 1, fuseHalfWidth: 1, wingFrontY: 9, wingHalfSpan: 11, wingBackY: 15,
  tailHalfSpan: 4, tailY: 20, tailTipY: 22,
});
const widebody2Path = wingedOutline({
  noseY: 0.6, fuseHalfWidth: 1.7, wingFrontY: 8, wingHalfSpan: 12.3, wingBackY: 15.3,
  tailHalfSpan: 5, tailY: 21, tailTipY: 23.2,
});
const widebody3Base = wingedOutline({
  noseY: 0.4, fuseHalfWidth: 1.85, wingFrontY: 7.7, wingHalfSpan: 12.4, wingBackY: 15.4,
  tailHalfSpan: 5.1, tailY: 21.3, tailTipY: 23.5,
});
const widebody4Base = wingedOutline({
  noseY: 0.2, fuseHalfWidth: 2, wingFrontY: 7.3, wingHalfSpan: 12.6, wingBackY: 15.6,
  tailHalfSpan: 5.3, tailY: 21.7, tailTipY: 23.8,
});

// Trijet tail-mounted third engine -- the real, iconic silhouette cue for
// DC-10/MD-11/L-1011 (a small pod at the base of the tail fin), not a
// wing-nacelle count. Wound the same direction (clockwise from its own
// top point) as every other shape in this file.
const widebody3TailEngine = poly([
  [11.3, 18.6], [12, 17.2], [12.7, 18.6], [12, 19.7],
]);

// 747-style upper-deck hump just behind the nose.
const widebody4NoseHump = poly([
  [10.8, 5.4], [12, 3.4], [13.2, 5.4], [12, 6.5],
]);

// Bizjet: wing root pushed well aft (low, rear-mounted wing) and a plain
// tapered tail (no flare) since its tail feature is the separate T-tail
// piece below -- both real bizjet cues (Learjet/Citation/Challenger/
// Gulfstream commonly have exactly this low-rear-wing + T-tail layout).
const bizjetBody = symmetricOutline([
  [CENTER_X, 2],
  [CENTER_X + 0.9, 8],
  [CENTER_X + 9, 16],
  [CENTER_X + 0.9, 18],
  [CENTER_X + 0.6, 21],
  [CENTER_X, 21.6],
]);
const bizjetFin = poly([[11.6, 19], [12.4, 19], [12.4, 21.4], [11.6, 21.4]]);
const bizjetStabilizer = poly([[9, 19.3], [15, 19.3], [15, 18.6], [9, 18.6]]);

// Military transport / cargo family: a wide, constant-width (boxy)
// fuselage -- deliberately much wider relative to its own wingspan than
// any airliner, so the fat body (not the wing) dominates the silhouette,
// plus a short, blunt tail flare (not a sharp taper) for the loadmaster-
// ramp cue. The two differ from each other only by wing sweep --
// turboprops have straighter, less-swept wings than jet-powered
// transports, a real visual cue for this class, not an invented one.
const cargoTurbopropPath = wingedOutline({
  noseY: 2.5, fuseHalfWidth: 2.4, wingFrontY: 11.5, wingHalfSpan: 11, wingBackY: 12.5,
  tailFuseHalfWidth: 2.2, tailHalfSpan: 3.2, tailY: 19.5, tailTipY: 21.5,
});
const cargoJetPath = wingedOutline({
  noseY: 2, fuseHalfWidth: 2.2, wingFrontY: 9, wingHalfSpan: 11.5, wingBackY: 14.5,
  tailFuseHalfWidth: 2, tailHalfSpan: 3.4, tailY: 19.8, tailTipY: 21.6,
});

// Fighter/attack jet: short fuselage, small tail, and a sharply swept
// (delta-like) wing whose span is large relative to the fuselage length.
const militaryJetPath = wingedOutline({
  noseY: 3, fuseHalfWidth: 0.9, wingFrontY: 9, wingHalfSpan: 11.5, wingBackY: 16,
  tailHalfSpan: 2.5, tailY: 17.5, tailTipY: 19,
});

// Glider: an almost perfectly straight (unswept), edge-to-edge wing (the
// longest, thinnest span of any icon here) and a very slim fuselage.
const gliderPath = wingedOutline({
  noseY: 4, fuseHalfWidth: 0.5, wingFrontY: 11.8, wingHalfSpan: 12, wingBackY: 12.2,
  tailHalfSpan: 2, tailY: 19.5, tailTipY: 21,
});

// Unknown -- deliberately the plainest shape in the set (a straight,
// unswept wing and almost no tail flare at all): this is the most-shown
// icon of all, and must read as "a generic, unclassified aircraft", not be
// mistaken for any real classified category.
const unknownPath = wingedOutline({
  noseY: 3, fuseHalfWidth: 0.9, wingFrontY: 11, wingHalfSpan: 9.5, wingBackY: 11.6,
  tailFuseHalfWidth: 0.9, tailHalfSpan: 1.2, tailY: 19, tailTipY: 20.5,
});

const ICON_PATHS = {
  narrowbody: narrowbodyPath,
  widebody2: widebody2Path,
  widebody3: combine(widebody3Base, widebody3TailEngine),
  widebody4: combine(widebody4Base, widebody4NoseHump),

  // Light single-engine GA: same outline technique, unswept wing, short
  // fuselage, plus a small nose-prop dot.
  light: combine(
    wingedOutline({
      noseY: 3, fuseHalfWidth: 0.7, wingFrontY: 8.3, wingHalfSpan: 9.5, wingBackY: 9.7,
      tailHalfSpan: 2.6, tailY: 18.5, tailTipY: 20,
    }),
    ellipse(12, 2.2, 1, 1),
  ),

  bizjet: combine(bizjetBody, bizjetFin, bizjetStabilizer),

  cargo_turboprop: cargoTurbopropPath,
  cargo_jet: cargoJetPath,
  military_jet: militaryJetPath,

  // Special-mission (AWACS/tanker/recon): a widebody2 airframe plus a
  // dorsal disc -- the one unmistakable cue no other icon in this set has.
  special: combine(widebody2Path, ellipse(12, 10.3, 3.4, 1.5)),

  // Helicopter -- carried over from the old module, flattened from
  // per-element <rect transform="rotate(...)"> into absolute coordinates
  // (a <path>'s subpaths can't carry their own transform), same silhouette.
  helicopter: combine(
    poly([[6.84, 2.85], [18.15, 14.16], [17.16, 15.15], [5.85, 3.84]]), // rotor blade A
    poly([[5.85, 14.16], [17.16, 2.85], [18.15, 3.84], [6.84, 15.15]]), // rotor blade B
    ellipse(12, 9, 1, 1), // rotor hub
    poly([[11.3, 9], [12.7, 9], [12.7, 11.2], [11.3, 11.2]]), // mast
    poly([[12, 7.5], [14.8, 11.8], [14.2, 15.3], [9.8, 15.3], [9.2, 11.8]]), // cabin
    poly([[10.8, 15.3], [13.2, 15.3], [12.5, 21.8], [11.5, 21.8]]), // tail boom
    poly([[9.3, 21.2], [14.7, 21.2], [14.7, 22.6], [9.3, 22.6]]), // skid
  ),

  glider: gliderPath,

  // Balloon: round envelope + a basket -- deliberately not aircraft-shaped
  // at all, and symmetric, so rotation by `track` (which balloons rarely
  // report meaningfully anyway) never looks wrong.
  balloon: combine(
    ellipse(12, 10, 6, 7),
    poly([[10, 19.5], [14, 19.5], [14, 22], [10, 22]]),
  ),

  // Drone/quadcopter: a compact X of four short arms plus a small center
  // body -- small and dense on purpose (multiplier 0.8), reads as
  // "small unmanned thing", not a scaled-down aircraft silhouette.
  drone: combine(
    poly([[9.6, 8.75], [15.25, 14.4], [14.4, 15.25], [8.75, 9.6]]),
    poly([[8.75, 14.4], [14.4, 8.75], [15.25, 9.6], [9.6, 15.25]]),
    poly([[10.8, 10.8], [13.2, 10.8], [13.2, 13.2], [10.8, 13.2]]),
  ),

  // Ground vehicle: a small boxy shape with two wheel bumps -- deliberately
  // NOT aircraft-shaped, so it reads immediately as "not a plane" even at
  // 14px.
  ground_vehicle: combine(
    poly([[9.5, 8], [14.5, 8], [14.5, 17], [9.5, 17]]),
    ellipse(10, 17.5, 1, 1),
    ellipse(14, 17.5, 1, 1),
  ),

  unknown: unknownPath,

  // Ground-station beacon (typeCode 'TWR') -- not a real aircraft type at
  // all, kept outside the 16-icon spec on purpose (see CLAUDE.md). Carried
  // over from the old module, flattened to one <path>.
  tower: combine(
    poly([[12, 2], [12.8, 2], [17, 22], [15.2, 22]]),
    poly([[11.2, 2], [12, 2], [8.8, 22], [7, 22]]),
    poly([[6.5, 21], [17.5, 21], [17.5, 22.4], [6.5, 22.4]]),
    poly([[9.3, 8], [14.7, 8], [14.7, 9], [9.3, 9]]),
    poly([[8.5, 14], [15.5, 14], [15.5, 15], [8.5, 15]]),
    poly([[7.7, 18.5], [16.3, 18.5], [16.3, 19.5], [7.7, 19.5]]),
    ellipse(12, 1.2, 1, 1),
  ),
};

// Every id from the icon spec (in the order given), plus 'tower' at the
// end since it's explicitly outside the 16-icon list.
export const PLANE_ICON_IDS = [
  'narrowbody', 'widebody2', 'widebody3', 'widebody4',
  'light', 'bizjet', 'cargo_turboprop', 'cargo_jet',
  'military_jet', 'special', 'helicopter', 'glider',
  'balloon', 'drone', 'ground_vehicle', 'unknown',
  'tower',
];

// Size multipliers relative to the user's icon-size slider value -- never a
// fixed pixel count, so they scale together with that setting. Values taken
// from the task write-up's own examples (widebody* = 1.25, light/glider/
// drone = 0.8) where given; the rest are reasoned proportionally (see the
// icon-set task write-up) and are exactly what /dev/icons exists to let a
// human eyeball and correct.
export const ICON_SIZE_MULTIPLIERS = {
  narrowbody: 1,
  widebody2: 1.25,
  widebody3: 1.25,
  widebody4: 1.25,
  light: 0.8,
  bizjet: 0.9,
  cargo_turboprop: 1.15,
  cargo_jet: 1.25,
  military_jet: 0.9,
  special: 1.25,
  helicopter: 0.9,
  glider: 0.8,
  balloon: 0.85,
  drone: 0.8,
  ground_vehicle: 0.75,
  unknown: 1,
  tower: 1,
};

export function getIconPath(kind) {
  return ICON_PATHS[kind] ?? ICON_PATHS.unknown;
}

export function getIconSizeMultiplier(kind) {
  return ICON_SIZE_MULTIPLIERS[kind] ?? 1;
}
