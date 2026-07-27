import { getConfig, setConfig } from './db.js';

export const DEFAULT_PORT = 1090; // 1090 MHz, the ADS-B frequency

// Ports we refuse to bind to, with the reason surfaced to the user. readsb's
// own ports would break the receiver MLPR depends on; 8080/8085 are used by
// other apps on the target host (see CLAUDE.md's networking rules).
const RESERVED_PORTS = new Map([
  [8080, 'commonly used by other web apps (including readsb/tar1090 itself)'],
  [8085, 'commonly used by other apps on this host'],
  [30001, "readsb's raw input port"],
  [30002, "readsb's raw output port"],
  [30003, "readsb's SBS/BaseStation output port"],
  [30004, "readsb's beast input port"],
  [30005, "readsb's beast output port"],
  [30104, "readsb's beast input port"],
]);

// Returns { ok: true, port } or { ok: false, error }.
export function validatePort(value) {
  if (!Number.isInteger(value)) {
    return { ok: false, error: 'Port must be a whole number.' };
  }
  // Below 1024 needs root to bind, which MLPR deliberately never runs as.
  if (value < 1024 || value > 65535) {
    return { ok: false, error: 'Port must be between 1024 and 65535.' };
  }
  if (RESERVED_PORTS.has(value)) {
    return { ok: false, error: `Port ${value} is reserved — ${RESERVED_PORTS.get(value)}.` };
  }
  return { ok: true, port: value };
}

export function getConfiguredPort() {
  const stored = getConfig('port');
  if (stored === undefined || stored === null) return null;
  const parsed = Number(stored);
  return Number.isInteger(parsed) ? parsed : null;
}

export function setConfiguredPort(port) {
  setConfig('port', String(port));
}

// MLPR_PORT wins when set, so an explicit deployment/dev override is never
// silently overridden by whatever happens to be saved in the database. The
// UI reports which of the two is actually in effect rather than showing a
// setting that quietly does nothing.
export function resolvePort(env = process.env) {
  if (env.MLPR_PORT) {
    return { port: Number(env.MLPR_PORT), source: 'env' };
  }
  const stored = getConfiguredPort();
  if (stored !== null) return { port: stored, source: 'config' };
  return { port: DEFAULT_PORT, source: 'default' };
}
