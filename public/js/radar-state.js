const liveAircraft = new Map(); // hex -> latest normalized aircraft
let messagesCounter = null; // { value, atMs }
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

export function noteMessagesCounter(value, atMs) {
  messagesCounter = { value, atMs };
  notify();
}

export function getMessagesCounter() {
  return messagesCounter;
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
