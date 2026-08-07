const liveAircraft = new Map(); // hex -> latest normalized aircraft
// Receiver-level figures only: the aircraft count is deliberately absent,
// because it is answerable from liveAircraft above -- the same set the map
// and the List panel draw. It used to be sent by the server as well, which
// meant two counts of the same thing on one screen.
let liveStats = { messagesPerSec: null, maxRangeLastHourKm: null };
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
  positionStaleHexes.delete(hex);
}

export function clearAircraft() {
  liveAircraft.clear();
  positionStaleHexes.clear();
}

// A position ages out of usefulness long before an aircraft stops being
// heard: readsb keeps re-reporting a last known lat/lon while its own
// seen_pos climbs, and app.js stops plotting -- and retires the marker --
// once that fix is older than REMOVE_MS. The aircraft object still carries
// those (now stale) coordinates, so a consumer asking "typeof lat ===
// 'number'" gets a confident yes for an aircraft the map is deliberately
// not drawing. That is exactly what list.js used to ask, which is why a row
// could read as fully positioned with nothing on the map to match it.
//
// app.js is the one place that knows the answer, because it owns the same
// threshold the map plots by -- so it publishes the fact here instead of
// every consumer re-deriving it (and drifting from the map's own rule the
// first time that rule changes, as it already has twice).
const positionStaleHexes = new Set();

export function setPositionStale(hex, stale) {
  if (stale) positionStaleHexes.add(hex);
  else positionStaleHexes.delete(hex);
}

export function isPositionStale(hex) {
  return positionStaleHexes.has(hex);
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

// Redraws driven from here (list.js's drawTable, stats.js's drawNowSection)
// are the app's one piece of periodic work the browser does NOT throttle in
// a background tab: they hang off incoming WebSocket deltas, not a timer, so
// a hidden tab kept rebuilding the whole list <table> and the Stats tiles
// about once a second for nobody. Suppressed while hidden and flushed once
// on the way back, so returning to the tab shows current data immediately
// rather than waiting for the next delta.
//
// Deliberately gated here rather than in each subscriber: it's one place,
// and it covers anything that subscribes later without them having to
// remember. State itself is never suppressed -- only the redraw signal --
// so the data is already correct the moment the tab is visible again.
let notifyPending = false;

function documentHidden() {
  // No `document` under plain `node --test`, where this module is unit-
  // tested -- treat that as "always visible" so tests see every notify.
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (!documentHidden() && notifyPending) {
      notifyPending = false;
      for (const fn of listeners) fn();
    }
  });
}

function notify() {
  if (documentHidden()) {
    notifyPending = true;
    return;
  }
  for (const fn of listeners) fn();
}

// The main map's current view, mirrored here purely so other UI modules can
// read it without importing app.js -- which they cannot, since app.js
// imports panels.js -> settings.js -> area-editor.js and the cycle back
// would be circular. Same "app.js pushes, others pull" arrangement
// setSelectedHex/getSelectedHex already uses.
//
// Written by app.js on every moveend (which a jumpTo/flyTo also fires, so
// the initial auto-centering registers too). null until the map has settled
// once -- readers must treat that as "no view yet" rather than assuming a
// default.
let mapView = null;

export function setMapView(view) {
  mapView = view;
}

export function getMapView() {
  return mapView;
}
