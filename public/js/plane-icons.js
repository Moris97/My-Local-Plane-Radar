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
// - widebody2 and widebody3 are, by explicit request, the exact same
//   silhouette as narrowbody -- only ICON_SIZE_MULTIPLIERS (1.25x) tells
//   them apart visually. widebody4 reuses that same silhouette too, but
//   with a second, same-size engine nacelle per wing (see widebody4Path).
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
// handful of icons that layer on a small extra cue (widebody4's second
// nacelle, special's dorsal disc) -- those embellishments are wound the
// same direction as the main outline (poly()'s point order is consistently
// nose-side-first/clockwise throughout this file) so they union with it
// under the default nonzero fill rule instead of any risk of cancelling
// out as a hole.

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

function distanceBetween(a, b) {
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

function pointToward(from, to, dist) {
  const t = dist / distanceBetween(from, to);
  return [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t];
}

// A handful of straight-line points interpolating a fuselage's half-width
// from `fromX` to `toX` over `y0`..`y1` -- a gradual multi-point taper
// instead of one sharp step (used by `light`'s cabin-to-boom narrowing).
function taperPoints(fromX, toX, y0, y1, steps) {
  const pts = [];
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    pts.push([fromX + (toX - fromX) * t, y0 + (y1 - y0) * t]);
  }
  return pts;
}

// A smooth, properly oval/rounded nose cap -- samples a quarter-ellipse
// (nose tip to full fuselage half-width) at several angles, rather than
// 2-3 hand-placed points, which is what actually reads as "rounded"
// instead of "faceted" (used by cargo_turboprop's blunt transport nose).
function ovalNosePoints(fuseHalfWidth, noseTipY, noseDepth, steps) {
  const pts = [[CENTER_X, noseTipY]];
  for (let i = 1; i <= steps; i++) {
    const theta = (Math.PI / 2) * (i / steps);
    pts.push([
      CENTER_X + fuseHalfWidth * Math.sin(theta),
      noseTipY + noseDepth * (1 - Math.cos(theta)),
    ]);
  }
  return pts;
}

// Like poly(), but corners named in `radiusByPoint` (a Map from "x,y" ->
// radius) get a small quadratic-curve fillet instead of a sharp point --
// pulled back `radius` units along each adjoining edge, joined by a
// bezier through the original corner. Used sparingly: most corners here
// are deliberately sharp (that's what reads as an aircraft's edges at
// 14px), this is only for the couple of "shoulder" corners called out as
// too blocky in review.
function polyRounded(points, radiusByPoint) {
  const n = points.length;
  const parts = [];
  points.forEach((curr, i) => {
    const radius = radiusByPoint.get(`${curr[0]},${curr[1]}`);
    if (!radius) {
      parts.push(`${i === 0 ? 'M' : 'L'}${curr[0]},${curr[1]}`);
      return;
    }
    const prev = points[(i - 1 + n) % n];
    const next = points[(i + 1) % n];
    const a = pointToward(curr, prev, radius);
    const b = pointToward(curr, next, radius);
    parts.push(`${i === 0 ? 'M' : 'L'}${a[0]},${a[1]}`);
    parts.push(`Q${curr[0]},${curr[1]} ${b[0]},${b[1]}`);
  });
  parts.push('Z');
  return parts.join(' ');
}

// symmetricOutline() with a few named corners on the right half filleted --
// automatically filleting their mirrored counterpart on the left half too,
// so a caller only ever names the right-side coordinate.
function symmetricOutlineRounded(rightPoints, roundedCorners, radius) {
  const middle = rightPoints.slice(1, -1);
  const left = middle.slice().reverse().map(([x, y]) => [2 * CENTER_X - x, y]);
  const full = [...rightPoints, ...left];
  const radiusByPoint = new Map();
  for (const [x, y] of roundedCorners) {
    radiusByPoint.set(`${x},${y}`, radius);
    radiusByPoint.set(`${2 * CENTER_X - x},${y}`, radius);
  }
  return polyRounded(full, radiusByPoint);
}

// Fillets every corner of a standalone small polygon (e.g. an engine
// nacelle) by the same radius -- unlike symmetricOutlineRounded, there's no
// separate mirrored copy to account for here since callers already mirror
// the whole shape via mirrored() before rendering it.
function polyAllRounded(points, radius) {
  const radiusByPoint = new Map(points.map(([x, y]) => [`${x},${y}`, radius]));
  return polyRounded(points, radiusByPoint);
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

// Mirrors a right-side point list to the left (x -> 24 - x), for parts that
// come in symmetric pairs but aren't part of the main outline (engine pods).
// The point order is *reversed* as well, which is load-bearing: mirroring x
// alone flips the polygon's winding direction, and a subpath wound opposite
// to the outline it overlaps cancels against it under the default nonzero
// fill rule -- i.e. the engine punches a hole through the wing instead of
// merging with it. Hit for real the first time the narrowbody nacelles were
// drawn; reversing here restores the original winding.
function mirrored(points) {
  return points.map(([x, y]) => [2 * CENTER_X - x, y]).reverse();
}

// narrowbody is authored explicitly rather than via wingedOutline: it's the
// reference airliner shape the whole set is judged against, so it gets a
// wide constant-width fuselage, a properly triangular swept wing, and two
// wing-mounted engine nacelles -- none of which the generic helper can
// express.
//
// The wing geometry below was picked by rendering a grid of sweep/chord
// variants side by side against a real top-down airliner silhouette and
// choosing from them -- the same approach the trail altitude gradient was
// tuned with, and for the same reason: guessing numbers here converges
// slowly and badly. If this needs retuning again, regenerate that
// comparison rather than nudging values one at a time.
//
// Two failed attempts worth not repeating. (1) An almost perpendicular
// leading edge (~8 degrees) put the wingtip *ahead* of the root chord's
// midpoint and read as a straight wing with a forward-swept trailing edge.
// (2) Steeper sweep alone, but with the root chord running back to y=18.6,
// left barely a unit of bare fuselage between the wing and the tailplane,
// so the whole rear half filled in as one solid diamond. Both the sweep
// (~39 degrees, tip landing aft of even the root trailing edge) and the
// short root chord that leaves a visible fuselage "waist" ahead of the
// tail are load-bearing -- neither alone is enough.
//
// A nacelle's position along the wingspan is given as a *fraction* of the
// way from the fuselage side to the wingtip (never an absolute offset), and
// its position along the wing's leading edge is derived from that same
// fraction rather than eyeballed -- so nacelles stay glued to the leading
// edge if the span or sweep is ever retuned, and adding a second one (see
// widebody4 below) is just another fraction, not new geometry.
const NB_FUSE_HALF_WIDTH = 1.7;
const NB_WING_HALF_SPAN = 11.2;
const NB_WING_ROOT_LE_Y = 9.2;
const NB_WING_TIP_LE_Y = 16.9;

// Nacelle: sits astride the leading edge, protruding further forward than
// aft (how an underwing pod actually reads from above), tapering slightly
// at the back. Corners are filleted too (NB_ENGINE_ROUND_RADIUS) -- a
// zoomed-in screenshot showed the fuselage-shoulder fillet clearly but the
// nacelle's own corners were still sharp rectangles, which is what was
// actually being pointed at.
const NB_ENGINE_HALF_WIDTH = 0.95;
const NB_ENGINE_ROUND_RADIUS = 0.35;

function nacelleAt(spanFraction) {
  const offset = NB_FUSE_HALF_WIDTH + (NB_WING_HALF_SPAN - NB_FUSE_HALF_WIDTH) * spanFraction;
  const leadingEdgeY =
    NB_WING_ROOT_LE_Y
    + ((offset - NB_FUSE_HALF_WIDTH) / (NB_WING_HALF_SPAN - NB_FUSE_HALF_WIDTH))
      * (NB_WING_TIP_LE_Y - NB_WING_ROOT_LE_Y);
  return [
    [CENTER_X + offset - NB_ENGINE_HALF_WIDTH, leadingEdgeY - 1.9],
    [CENTER_X + offset + NB_ENGINE_HALF_WIDTH, leadingEdgeY - 1.9],
    [CENTER_X + offset + NB_ENGINE_HALF_WIDTH - 0.18, leadingEdgeY + 1.5],
    [CENTER_X + offset - NB_ENGINE_HALF_WIDTH + 0.18, leadingEdgeY + 1.5],
  ];
}

// narrowbody/widebody2/widebody3 all have one nacelle per wing, one third
// of the way out to the tip.
const nbEngineRight = nacelleAt(1 / 3);

// The two "shoulder" corners -- nose taper meeting the straight fuselage
// side, and that side meeting the wing's leading edge -- read as too sharp/
// blocky at a glance (reported directly against a rendered comparison);
// both get a small fillet. NB_ROUND_RADIUS is deliberately small -- the
// point is to take the edge off, not to round the airframe into a blob.
const NB_ROUND_RADIUS = 0.55;
// Tailplane half-span ("width" -- see the point list below for the
// width/height convention this project uses from here on).
const NB_TAIL_HALF_SPAN = 5.6;
const NB_SHOULDER_CORNERS = [
  [CENTER_X + NB_FUSE_HALF_WIDTH, 6.2],
  [CENTER_X + NB_FUSE_HALF_WIDTH, NB_WING_ROOT_LE_Y],
];

// The bare airframe outline, shared as-is by narrowbody/widebody2/widebody3
// (identical shape, only the size multiplier in ICON_SIZE_MULTIPLIERS makes
// the widebodies read as bigger -- requested directly rather than drawing
// three near-duplicate shapes) and reused by widebody4 too (same outline,
// just a second nacelle per wing -- see below).
const narrowbodyOutline =
  symmetricOutlineRounded([
    // Nose is deliberately rounded over three points rather than one sharp
    // apex -- a single nose vertex reads as a missile/dart, not an airliner
    // (visible immediately when compared side by side with real top-down
    // airliner silhouettes).
    [CENTER_X, 1.5],                                  // nose tip
    [CENTER_X + 0.75, 2.1],
    [CENTER_X + 1.35, 3.6],
    NB_SHOULDER_CORNERS[0],                           // full fuselage width
    NB_SHOULDER_CORNERS[1],                           // wing root leading edge
    [CENTER_X + NB_WING_HALF_SPAN, NB_WING_TIP_LE_Y], // wingtip leading edge
    [CENTER_X + NB_WING_HALF_SPAN, 17.3],             // wingtip trailing edge (near-pointed tip)
    // Root chord deliberately stops well short of the tailplane: the gap of
    // bare fuselage between wing trailing edge and tailplane ("the waist")
    // is what stops the wing and tail reading as one merged mass.
    [CENTER_X + NB_FUSE_HALF_WIDTH, 15.2],            // wing root trailing edge
    [CENTER_X + NB_FUSE_HALF_WIDTH, 19.6],            // rear fuselage (waist) / tailplane root leading edge
    // Tailplane is a smaller swept trapezoid matching the main wing's own
    // style (leading-edge sweep out to a near-pointed tip, a longer root
    // chord than tip chord) rather than the plain diamond first drawn --
    // called out directly against a reference icon showing a swept
    // tailplane, not a straight one. Chord depth (root and tip trailing
    // edges both, plus the tail cone below them) was then deepened a
    // second time on review -- the shape/sweep was right but read as too
    // shallow front-to-back; leading edges stay put, only how far each
    // trailing edge reaches toward the tail changed. Narrowed a third time
    // (NB_TAIL_HALF_SPAN 7.0 -> 5.6): "width" = left-right span with the
    // nose pointing up (icon x-axis), "height"/"depth" = nose-to-tail
    // extent (icon y-axis) -- the ask was narrower only, so just the tip
    // points' x moves; every y-coordinate here is untouched.
    [CENTER_X + NB_TAIL_HALF_SPAN, 22.66],            // tailplane tip leading edge
    [CENTER_X + NB_TAIL_HALF_SPAN, 23.8],             // tailplane tip trailing edge
    [CENTER_X + NB_FUSE_HALF_WIDTH, 22.9],            // tailplane root trailing edge
    [CENTER_X, 23.95],                                // tail cone
  ], NB_SHOULDER_CORNERS, NB_ROUND_RADIUS);

const narrowbodyPath = combine(
  narrowbodyOutline,
  polyAllRounded(nbEngineRight, NB_ENGINE_ROUND_RADIUS),
  polyAllRounded(mirrored(nbEngineRight), NB_ENGINE_ROUND_RADIUS),
);

// widebody2 and widebody3 are the exact same shape as narrowbody, scaled up
// by ICON_SIZE_MULTIPLIERS alone (1.25x) rather than drawn as distinct
// silhouettes -- requested directly, superseding this file's earlier
// per-widebody fuselage/wing/tail proportions and widebody3's tail-mounted
// third engine.
const widebody2Path = narrowbodyPath;
const widebody3Path = narrowbodyPath;

// widebody4 reuses the same bare outline too, but with a second nacelle per
// wing (four-engine jumbos -- 747/A380/A340/Il-96 -- are exactly this
// icon's real-world examples) at 1/3 and 2/3 of the way out to the
// wingtip, i.e. fuselage-engine-engine-wingtip at even spacing.
const widebody4Path = combine(
  narrowbodyOutline,
  polyAllRounded(nacelleAt(1 / 3), NB_ENGINE_ROUND_RADIUS),
  polyAllRounded(mirrored(nacelleAt(1 / 3)), NB_ENGINE_ROUND_RADIUS),
  polyAllRounded(nacelleAt(2 / 3), NB_ENGINE_ROUND_RADIUS),
  polyAllRounded(mirrored(nacelleAt(2 / 3)), NB_ENGINE_ROUND_RADIUS),
);

// Light single-engine GA (Cessna 152/172 class), rebuilt against a real
// top-down reference rather than the generic wingedOutline dart: three
// things that helper can't express, all visible in the reference.
// (1) A distinct wide "cabin pod" -- fuselage jumps from the nose taper to
// a cabin width and *stays* that width all the way through the wing root,
// front and back, rather than tapering smoothly like an airliner fuselage.
// (2) The wing is only very slightly swept (leading edge nearly
// perpendicular to the fuselage) but still tapers to a narrower tip chord
// -- unlike narrowbody's wing, sweep and taper are independent knobs here.
// (3) A long, thin tail boom, noticeably thinner than the cabin, carrying
// a small tapered tailplane echoing the main wing's own shape.
const LT_FUSE_HALF_WIDTH = 1.3;
const LT_BOOM_HALF_WIDTH = 0.45;
const LT_WING_HALF_SPAN = 10.3;
// Root chord deepened from an initial 3.1 (7.3->10.4) to 4.8 (7.0->11.8) --
// first render read as a thin blade across the fuselage, not the sturdy
// rectangular-ish wing a Cessna actually has; tip chord widened to match
// (1.2 -> 2.0) so the taper reads as "slightly narrower at the tip", not
// "the wing evaporates toward the tip".
const LT_WING_ROOT_LE_Y = 7.0;
const LT_WING_TIP_LE_Y = 7.8;
const LT_WING_TIP_TE_Y = 9.8;
const LT_WING_ROOT_TE_Y = 11.8;
const LT_TAIL_HALF_SPAN = 4.3;
// Cabin stays full width a bit past the wing's trailing edge (the "under
// the wing" plateau asked for directly), then narrows to the boom width
// gradually over LT_TAPER_LEN -- picked from a rendered width/taper-length
// comparison grid, "very long taper" being the longest of those.
const LT_PLATEAU_END_Y = LT_WING_ROOT_TE_Y + 0.6;
const LT_TAPER_LEN = 4.2;

// Nose "propeller": a thin bar ("-"), not a circle -- a circle doesn't
// read as a propeller at all. Width is 1/3 of the full wingspan, per the
// same fraction-of-span convention nacelles use elsewhere in this file.
// Sits below (not right at) the very tip: moving it down off the tip is
// what reveals a small triangular nose cone poking out ahead of it,
// rather than the bar swallowing the tip entirely.
const LT_PROP_HALF_WIDTH = LT_WING_HALF_SPAN / 3;
const LT_PROP_Y = 2.7;
const LT_PROP_THICKNESS = 0.5;
const lightPropBar = poly([
  [CENTER_X - LT_PROP_HALF_WIDTH, LT_PROP_Y - LT_PROP_THICKNESS / 2],
  [CENTER_X + LT_PROP_HALF_WIDTH, LT_PROP_Y - LT_PROP_THICKNESS / 2],
  [CENTER_X + LT_PROP_HALF_WIDTH, LT_PROP_Y + LT_PROP_THICKNESS / 2],
  [CENTER_X - LT_PROP_HALF_WIDTH, LT_PROP_Y + LT_PROP_THICKNESS / 2],
]);

const lightPath = combine(
  symmetricOutline([
    [CENTER_X, 2.05],                                  // nose tip (small cone ahead of the prop bar)
    [CENTER_X + LT_FUSE_HALF_WIDTH * 0.6, 3.4],
    [CENTER_X + LT_FUSE_HALF_WIDTH, 4.6],              // cabin shoulder reached
    [CENTER_X + LT_FUSE_HALF_WIDTH, LT_WING_ROOT_LE_Y], // wing root leading edge (still cabin width)
    [CENTER_X + LT_WING_HALF_SPAN, LT_WING_TIP_LE_Y],  // wingtip leading edge (near-perpendicular)
    [CENTER_X + LT_WING_HALF_SPAN, LT_WING_TIP_TE_Y],  // wingtip trailing edge (tapered tip)
    [CENTER_X + LT_FUSE_HALF_WIDTH, LT_WING_ROOT_TE_Y], // wing root trailing edge (still cabin width)
    [CENTER_X + LT_FUSE_HALF_WIDTH, LT_PLATEAU_END_Y], // cabin width plateau continues just past the wing
    ...taperPoints(
      CENTER_X + LT_FUSE_HALF_WIDTH, CENTER_X + LT_BOOM_HALF_WIDTH,
      LT_PLATEAU_END_Y, LT_PLATEAU_END_Y + LT_TAPER_LEN, 4,
    ),                                                  // gradual taper down to boom width
    [CENTER_X + LT_BOOM_HALF_WIDTH, 18.3],             // long thin tail boom
    [CENTER_X + LT_TAIL_HALF_SPAN, 18.9],              // tailplane tip leading edge
    [CENTER_X + LT_TAIL_HALF_SPAN, 19.8],              // tailplane tip trailing edge
    [CENTER_X + LT_BOOM_HALF_WIDTH, 20.3],             // tailplane root trailing edge
    [CENTER_X, 21.0],                                  // tail cone
  ]),
  lightPropBar,
);

// Bizjet (Learjet/Citation/Challenger/Gulfstream class): a genuinely
// slender fuselage with a small, centered-to-slightly-aft swept wing (not
// a big delta -- a wide wing was the first attempt here and got called an
// "SR-71" on sight against a reference photo), a small swept tailplane
// merged into the one continuous outline (same technique as narrowbody's
// tail, just smaller), and a pair of rear FUSELAGE-mounted engine pods
// (not wing-mounted) sitting just ahead of the tailplane root, close in
// against the boom -- the real distinguishing cue for this whole class.
// Every number here came out of several rounds of render-compare-adjust
// against real reference photos, not a single guess -- if this needs
// retuning again, use that same loop rather than nudging blind.
const bizjetBody = symmetricOutline([
  [CENTER_X, 1.2],                    // nose tip
  [CENTER_X + 0.4, 2.8],
  [CENTER_X + 0.8, 5.3],               // slender fuselage width reached
  [CENTER_X + 0.8, 7.8],                // wing root leading edge
  [CENTER_X + 6.0, 10.1],               // wingtip leading edge
  [CENTER_X + 5.8, 11.1],               // wingtip trailing edge (tapered)
  [CENTER_X + 0.8, 11.3],               // wing root trailing edge
  [CENTER_X + 0.8, 11.8],               // brief waist plateau
  [CENTER_X + 0.5, 13.0],               // taper to boom width
  [CENTER_X + 0.5, 14.8],               // tail root leading edge
  [CENTER_X + 3.8, 16.9],               // tailplane tip leading edge
  [CENTER_X + 3.6, 17.7],               // tailplane tip trailing edge
  [CENTER_X + 0.5, 17.0],               // tailplane root trailing edge
  [CENTER_X, 18.0],                     // tail cone
]);
// Fuselage-mounted engine pod -- pointed front and back, unlike the
// wing-leading-edge nacelles elsewhere in this file (nacelleAt()); those
// sit astride a wing's leading edge, these sit alongside the fuselage
// itself, close against the boom, just ahead of the tailplane root.
const bizjetEngineRight = [
  [CENTER_X + 1.2 - 0.7, 12.3 + 0.3],
  [CENTER_X + 1.2, 12.3],
  [CENTER_X + 1.2 + 0.7, 12.3 + 0.3],
  [CENTER_X + 1.2 + 0.7, 15.3 - 0.3],
  [CENTER_X + 1.2, 15.3],
  [CENTER_X + 1.2 - 0.7, 15.3 - 0.3],
];

// Military transport turboprop (C-130/A400M/C295/An-26/C-27J/M28 class):
// rebuilt from scratch against real references, several rounds of direct
// feedback. A blunt, properly oval nose (ovalNosePoints, not a taper to a
// point -- transports have a short rounded nose, nothing like a jet's);
// a practically RECTANGULAR wing (constant chord root-to-tip, minimal
// sweep) with all 4 corners (root/tip x leading/trailing edge) filleted --
// an earlier tapered-tip version read as "cut corners", and a later
// hang-glider-style gently curved sweep was tried and explicitly rejected
// in favor of reverting to this rectangular-with-rounded-corners version,
// which is now final; four wing-mounted turboprop nacelles (two per wing,
// at 1/3 and 2/3 of the way to the tip -- the real cue for this class,
// most of its reference types are twins but C-130/A400M are quads), each
// with a thin perpendicular "propeller disc" bar, same visual language as
// light's nose prop bar; and the same short blunt tail-flare cue (not a
// sharp taper) for the loadmaster ramp, feeding a straight (unswept),
// wide T-tail -- turboprops have straighter, less-swept everything than
// jet-powered transports, the real distinguishing cue for the whole class.
const CTP_FUSE_HALF_WIDTH = 1.9;
const CTP_NOSE_TIP_Y = 2.5;
const CTP_WING_ROOT_LE_Y = 10.0;
const CTP_WING_HALF_SPAN = 11.0;
const CTP_WING_SWEEP = 0.4;
const CTP_WING_CHORD = 3.2; // same depth at root and tip -- no taper
const CTP_TAIL_HALF_SPAN = 4.5;
const CTP_TAIL_CHORD = 1.6;

const CTP_WING_TIP_LE_Y = CTP_WING_ROOT_LE_Y + CTP_WING_SWEEP;
const CTP_WING_TIP_TE_Y = CTP_WING_TIP_LE_Y + CTP_WING_CHORD;
const CTP_WING_ROOT_TE_Y = CTP_WING_ROOT_LE_Y + CTP_WING_CHORD;
const CTP_WAIST_END_Y = CTP_WING_ROOT_TE_Y + 1.0;
const CTP_FLARE_Y = CTP_WAIST_END_Y + 2.5;
const CTP_TAIL_ROOT_Y = CTP_FLARE_Y + 1.5;
const CTP_TAIL_TIP_LE_Y = CTP_TAIL_ROOT_Y + 0.6;
const CTP_TAIL_TIP_TE_Y = CTP_TAIL_TIP_LE_Y + CTP_TAIL_CHORD;
const CTP_TAIL_ROOT_TE_Y = CTP_TAIL_ROOT_Y + CTP_TAIL_CHORD + 0.3;
const CTP_TAIL_CONE_Y = CTP_TAIL_ROOT_TE_Y + 1.2;

const ctpWingRootLE = [CENTER_X + CTP_FUSE_HALF_WIDTH, CTP_WING_ROOT_LE_Y];
const ctpWingTipLE = [CENTER_X + CTP_WING_HALF_SPAN, CTP_WING_TIP_LE_Y];
const ctpWingTipTE = [CENTER_X + CTP_WING_HALF_SPAN, CTP_WING_TIP_TE_Y];
const ctpWingRootTE = [CENTER_X + CTP_FUSE_HALF_WIDTH, CTP_WING_ROOT_TE_Y];

const cargoTurbopropOutline = symmetricOutlineRounded([
  ...ovalNosePoints(CTP_FUSE_HALF_WIDTH, CTP_NOSE_TIP_Y, 2.0, 5),
  ctpWingRootLE,
  ctpWingTipLE,
  ctpWingTipTE,
  ctpWingRootTE,
  [CENTER_X + CTP_FUSE_HALF_WIDTH, CTP_WAIST_END_Y],
  [CENTER_X + CTP_FUSE_HALF_WIDTH * 1.08, CTP_FLARE_Y],
  [CENTER_X + CTP_FUSE_HALF_WIDTH * 0.9, CTP_TAIL_ROOT_Y],
  [CENTER_X + CTP_TAIL_HALF_SPAN, CTP_TAIL_TIP_LE_Y],
  [CENTER_X + CTP_TAIL_HALF_SPAN, CTP_TAIL_TIP_TE_Y],
  [CENTER_X + CTP_FUSE_HALF_WIDTH * 0.9, CTP_TAIL_ROOT_TE_Y],
  [CENTER_X, CTP_TAIL_CONE_Y],
], [ctpWingRootLE, ctpWingTipLE, ctpWingTipTE, ctpWingRootTE], 0.6);

// Wing-mounted turboprop nacelle: a small pod plus a thin perpendicular
// propeller-disc bar at the front, straddling the wing's own leading edge
// (poking ahead of it, receding a bit into it) -- centering it entirely
// behind the LE line buried it invisibly inside the wing's own solid area
// on an earlier render.
function turbopropEngineAt(spanFraction) {
  const offset = CTP_FUSE_HALF_WIDTH + (CTP_WING_HALF_SPAN - CTP_FUSE_HALF_WIDTH) * spanFraction;
  const leadingEdgeY = CTP_WING_ROOT_LE_Y + (offset - CTP_FUSE_HALF_WIDTH) / (CTP_WING_HALF_SPAN - CTP_FUSE_HALF_WIDTH) * CTP_WING_SWEEP;
  const halfWidth = 0.7;
  const barHalfWidth = 1.0;
  const y0 = leadingEdgeY - 1.0;
  const y1 = leadingEdgeY + 1.0;
  const pod = [
    [CENTER_X + offset - halfWidth, y0 + 0.4],
    [CENTER_X + offset, y0],
    [CENTER_X + offset + halfWidth, y0 + 0.4],
    [CENTER_X + offset + halfWidth, y1],
    [CENTER_X + offset - halfWidth, y1],
  ];
  const bar = [
    [CENTER_X + offset - barHalfWidth, y0 - 0.15],
    [CENTER_X + offset + barHalfWidth, y0 - 0.15],
    [CENTER_X + offset + barHalfWidth, y0 + 0.15],
    [CENTER_X + offset - barHalfWidth, y0 + 0.15],
  ];
  return [pod, bar];
}

const [ctpEngine1Pod, ctpEngine1Bar] = turbopropEngineAt(1 / 3);
const [ctpEngine2Pod, ctpEngine2Bar] = turbopropEngineAt(2 / 3);

const cargoTurbopropPath = combine(
  cargoTurbopropOutline,
  poly(ctpEngine1Pod), poly(mirrored(ctpEngine1Pod)),
  poly(ctpEngine1Bar), poly(mirrored(ctpEngine1Bar)),
  poly(ctpEngine2Pod), poly(mirrored(ctpEngine2Pod)),
  poly(ctpEngine2Bar), poly(mirrored(ctpEngine2Bar)),
);
// Cargo jet (C-17/C-5M/An-124/IL-76 class): same overall military-transport
// silhouette language as cargo_turboprop -- high-wing, blunt tail-flare
// feeding a T-tail -- but the wing is visibly SWEPT (~25 degrees, tip
// leading edge well aft of the root's) rather than cargo_turboprop's
// near-rectangular wing, and the four engines are podded turbofans (no
// propeller-disc bar) instead of turboprop nacelles. Picked from a 5-way
// render comparison (pointed vs blunt-oval nose, crossed with moderate vs
// high wing sweep, plus a leaner slim-pod variant) -- the pointed nose +
// high sweep combination read closest to the An-124/IL-76 reference photos
// and was picked outright; if this needs retuning again, regenerate that
// same comparison rather than nudging values blind.
const CJ_FUSE_HALF_WIDTH = 2.0;
const CJ_WING_ROOT_LE_Y = 9.5;
const CJ_WING_SWEEP = 5.0;
const CJ_WING_HALF_SPAN = 11.2;
const CJ_WING_ROOT_CHORD = 3.2;
const CJ_WING_TIP_CHORD = 2.2;
const CJ_TAIL_SWEEP = 0.9;
const CJ_TAIL_HALF_SPAN = 4.3;
const CJ_TAIL_CHORD = 1.8;
// Podded turbofan half-width -- narrower than it looks at first glance
// because the pod is drawn long (see jetPodAt below): a big turbofan reads
// as an elongated pod, not a wide blob.
const CJ_POD_HALF_WIDTH = 0.8;

const CJ_WING_TIP_LE_Y = CJ_WING_ROOT_LE_Y + CJ_WING_SWEEP;
const CJ_WING_ROOT_TE_Y = CJ_WING_ROOT_LE_Y + CJ_WING_ROOT_CHORD;
const CJ_WING_TIP_TE_Y = CJ_WING_TIP_LE_Y + CJ_WING_TIP_CHORD;
const CJ_WAIST_END_Y = CJ_WING_ROOT_TE_Y + 1.0;
const CJ_FLARE_Y = CJ_WAIST_END_Y + 2.5;
const CJ_TAIL_ROOT_Y = CJ_FLARE_Y + 1.5;
const CJ_TAIL_TIP_LE_Y = CJ_TAIL_ROOT_Y + CJ_TAIL_SWEEP;
const CJ_TAIL_TIP_TE_Y = CJ_TAIL_TIP_LE_Y + CJ_TAIL_CHORD;
const CJ_TAIL_ROOT_TE_Y = CJ_TAIL_ROOT_Y + CJ_TAIL_CHORD + 0.3;
const CJ_TAIL_CONE_Y = CJ_TAIL_ROOT_TE_Y + 1.2;

const cjWingRootLE = [CENTER_X + CJ_FUSE_HALF_WIDTH, CJ_WING_ROOT_LE_Y];
const cjWingTipLE = [CENTER_X + CJ_WING_HALF_SPAN, CJ_WING_TIP_LE_Y];
const cjWingTipTE = [CENTER_X + CJ_WING_HALF_SPAN, CJ_WING_TIP_TE_Y];
const cjWingRootTE = [CENTER_X + CJ_FUSE_HALF_WIDTH, CJ_WING_ROOT_TE_Y];

const cargoJetOutline = symmetricOutlineRounded([
  // Pointed, tapered nose (unlike cargo_turboprop's blunt oval) -- the
  // sleeker jet-transport nose that read closest to the picked reference
  // photos, against the rounder-nosed alternative also compared.
  [CENTER_X, 2],
  [CENTER_X + CJ_FUSE_HALF_WIDTH * 0.45, 2.7],
  [CENTER_X + CJ_FUSE_HALF_WIDTH * 0.8, 4.3],
  [CENTER_X + CJ_FUSE_HALF_WIDTH, 5.5],
  cjWingRootLE,
  cjWingTipLE,
  cjWingTipTE,
  cjWingRootTE,
  [CENTER_X + CJ_FUSE_HALF_WIDTH, CJ_WAIST_END_Y],
  [CENTER_X + CJ_FUSE_HALF_WIDTH * 1.08, CJ_FLARE_Y],
  [CENTER_X + CJ_FUSE_HALF_WIDTH * 0.85, CJ_TAIL_ROOT_Y],
  [CENTER_X + CJ_TAIL_HALF_SPAN, CJ_TAIL_TIP_LE_Y],
  [CENTER_X + CJ_TAIL_HALF_SPAN, CJ_TAIL_TIP_TE_Y],
  [CENTER_X + CJ_FUSE_HALF_WIDTH * 0.85, CJ_TAIL_ROOT_TE_Y],
  [CENTER_X, CJ_TAIL_CONE_Y],
], [cjWingRootLE, cjWingTipLE, cjWingTipTE, cjWingRootTE], 0.55);

// Podded turbofan astride the wing's leading edge, two per wing (1/3 and
// 2/3 of the way to the tip, same fraction-of-span placement convention as
// nacelleAt/turbopropEngineAt) -- no propeller-disc bar, and a longer pod
// than either of those (a big turbofan is a long cylinder, not a stubby
// nacelle).
function jetPodAt(spanFraction) {
  const offset = CJ_FUSE_HALF_WIDTH + (CJ_WING_HALF_SPAN - CJ_FUSE_HALF_WIDTH) * spanFraction;
  const leadingEdgeY =
    CJ_WING_ROOT_LE_Y
    + ((offset - CJ_FUSE_HALF_WIDTH) / (CJ_WING_HALF_SPAN - CJ_FUSE_HALF_WIDTH)) * CJ_WING_SWEEP;
  const y0 = leadingEdgeY - 1.3;
  const y1 = leadingEdgeY + 1.3;
  return [
    [CENTER_X + offset - CJ_POD_HALF_WIDTH, y0 + 0.4],
    [CENTER_X + offset, y0],
    [CENTER_X + offset + CJ_POD_HALF_WIDTH, y0 + 0.4],
    [CENTER_X + offset + CJ_POD_HALF_WIDTH, y1 - 0.4],
    [CENTER_X + offset, y1],
    [CENTER_X + offset - CJ_POD_HALF_WIDTH, y1 - 0.4],
  ];
}

const cjPod1 = jetPodAt(1 / 3);
const cjPod2 = jetPodAt(2 / 3);

const cargoJetPath = combine(
  cargoJetOutline,
  poly(cjPod1), poly(mirrored(cjPod1)),
  poly(cjPod2), poly(mirrored(cjPod2)),
);

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
  widebody3: widebody3Path,
  widebody4: widebody4Path,

  light: lightPath,

  bizjet: combine(bizjetBody, poly(bizjetEngineRight), poly(mirrored(bizjetEngineRight))),

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
