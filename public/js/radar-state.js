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
