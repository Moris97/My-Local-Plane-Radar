// Per-browser settings only (localStorage). Anything that must be the same
// for everyone on the LAN -- notification rules, the watch list, the
// Settings password, the server port, the receiver's home location -- lives
// server-side in SQLite instead and is reached over /api/*. See CLAUDE.md's
// "Settings scope" section for which tab is which.
const STORAGE_KEY = 'mlpr-settings';

const defaults = {
  units: 'imperial',
  altitudeFilterMin: null,
  altitudeFilterMax: null,
  basemapMode: 'online', // 'online' (OpenFreeMap) | 'offline' (Natural Earth)
  // Map style only, not the app's own UI theme (panels/bottom bar stay dark
  // always). 'auto' follows sunrise/sunset at the receiver -- see
  // server/src/daylight.js and app.js's resolveMapTheme.
  mapTheme: 'light', // 'light' | 'dark' | 'auto'
  trailMode: 'click', // 'click' | 'all'
  shorterTrails: false, // performance option: cap client-side trail length lower than the server default
  showHomeMarker: true, // pulsing dot at the receiver's location -- see app.js's homeMarker
  aircraftIconSize: 40, // px, side of the .mlpr-plane marker
  planeColorMode: 'signalLoss', // 'signalLoss' | 'altitude' | 'speed'
  // Which fields appear in the small map label under each aircraft (empty
  // object/all-false = no label at all). Kept minimal by default (just the
  // callsign) so the map stays uncluttered until the user opts into more --
  // see app.js's buildAircraftLabel and aircraft-icon.js's setPlaneLabel.
  aircraftLabelFields: { flight: true, type: false, altitude: false, speed: false },
};

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? { ...defaults, ...JSON.parse(raw) } : { ...defaults };
  } catch {
    return { ...defaults };
  }
}

let settings = load();
const listeners = new Set();

function save() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  for (const fn of listeners) fn(settings);
}

export function getSettings() {
  return settings;
}

export function updateSettings(patch) {
  settings = { ...settings, ...patch };
  save();
}

export function onSettingsChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
