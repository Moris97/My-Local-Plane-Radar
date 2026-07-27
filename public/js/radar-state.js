const liveAircraft = new Map(); // hex -> latest normalized aircraft
let liveStats = { aircraftCount: 0, messagesPerSec: null, maxRangeKm: null };
let selectRequestHandler = null;
const listeners = new Set();

export function noteAircraft(hex, aircraft) {
  liveAircraft.set(hex, aircraft);
  notify();
}

export function removeAircraft(hex) {
  liveAircraft.delete(hex);
  notify();
}

export function clearAircraft() {
  liveAircraft.clear();
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
