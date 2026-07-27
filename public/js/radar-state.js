const liveAircraft = new Map(); // hex -> latest normalized aircraft
let liveStats = { aircraftCount: 0, messagesPerSec: null, maxRangeKm: null };
let selectRequestHandler = null;
const listeners = new Set();

// These three deliberately do NOT notify by themselves. app.js applies a
// whole batch at once -- every aircraft in one WS delta, or every hex swept
// in one forget-tick -- and is expected to call notifyAircraftChanged()
// exactly once after the batch, not per aircraft. A WS delta can carry
// dozens of updated aircraft; notifying per-aircraft used to mean list.js's
// onChange handler rebuilt its entire `<table>` from scratch dozens of
// times a second, which showed up as list scrolling/flicker under load.
// Batching this drops the redraw rate to once per delta (i.e. once per
// second, matching the server's own poll cadence).
export function noteAircraft(hex, aircraft) {
  liveAircraft.set(hex, aircraft);
}

export function removeAircraft(hex) {
  liveAircraft.delete(hex);
}

export function clearAircraft() {
  liveAircraft.clear();
}

export function notifyAircraftChanged() {
  notify();
}

export function getLiveAircraft() {
  return Array.from(liveAircraft.values());
}

export function getAircraftByHex(hex) {
  return liveAircraft.get(hex);
}

let inspectedHex = null;

export function setInspectedHex(hex) {
  inspectedHex = hex;
}

export function getInspectedHex() {
  return inspectedHex;
}

// The map/list "selected" aircraft (trail + popup shown for it) -- distinct
// from inspectedHex above, which is specifically "whose details panel is
// open". app.js keeps its own selectedHex as the source of truth (used in
// over a dozen places already) and mirrors it here purely so other UI
// modules -- list.js highlighting the selected row -- can read it without
// app.js having to import back from them. Unlike the aircraft mutators
// above, this DOES notify immediately: selection changes on a user click,
// not in a per-tick hot loop, so there's no batching concern here.
let selectedHex = null;

export function setSelectedHex(hex) {
  selectedHex = hex;
  notify();
}

export function getSelectedHex() {
  return selectedHex;
}

// Hover cross-highlighting between the map and the list (map icon <-> list
// row), both directions, kept deliberately separate from the main
// `listeners`/`notify()` channel above. That channel is shared with every
// aircraft-data change (batched to ~once/sec, see the mutators' comment),
// so routing hover through it would mean every mouseenter/mouseleave while
// dragging the cursor across a cluster of aircraft triggers list.js's full
// `drawTable()` rebuild -- reintroducing the exact redraw-storm problem
// that batching fixed. `onHoverChange` lets list.js subscribe to only the
// hover signal and do a cheap class-toggle on already-rendered rows
// instead.
const hoverListeners = new Set();
let hoveredHex = null;

export function setHoveredHex(hex) {
  hoveredHex = hex;
  for (const fn of hoverListeners) fn(hoveredHex);
}

export function getHoveredHex() {
  return hoveredHex;
}

export function onHoverChange(fn) {
  hoverListeners.add(fn);
  return () => hoverListeners.delete(fn);
}

// The other direction (list row hover -> highlight the map icon) doesn't
// need a broadcast state at all -- app.js is the only thing that acts on
// it (there's exactly one map), so a direct request/handler pair (same
// shape as setSelectRequestHandler/requestSelect above) is simpler than
// routing it through state just to immediately consume it.
let hoverRequestHandler = null;

export function setHoverRequestHandler(fn) {
  hoverRequestHandler = fn;
}

// hex is nullable -- null means "stop hovering."
export function requestHover(hex) {
  hoverRequestHandler?.(hex);
}

export function noteLiveStats(stats) {
  liveStats = stats;
  notify();
}

export function getLiveStats() {
  return liveStats;
}

export function setSelectRequestHandler(fn) {
  selectRequestHandler = fn;
}

export function requestSelect(hex) {
  selectRequestHandler?.(hex);
}

export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify() {
  for (const fn of listeners) fn();
}
