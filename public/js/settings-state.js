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
  // Fetches a photo from Planespotters (external site) when an aircraft's
  // details panel is opened -- see aircraft-panel.js's loadPhoto. Opt-out
  // matters here specifically because the project advertises a fully
  // offline mode; every other network call MLPR makes is to its own Pi.
  fetchAircraftPhotos: true,
  // Reception coverage overlay -- off by default (a niche, heavier feature,
  // not something every install wants cluttering the map). coverageBand is
  // 'all' or an antenna-stats.js ALTITUDE_BANDS index (0-8) -- see app.js's
  // refreshCoverage/ensureCoverageLayer.
  showCoverage: false,
  coverageBand: 'all',
  // List panel column/sort configuration -- see list.js/list-fields.js.
  // listColumns is an ordered array of list-fields.js keys; listSortLevels
  // is an ordered array of {key, asc} (VRS-style "sort by / then by", but
  // any number of levels rather than a fixed three). Defaults match the
  // list's pre-configurable-columns hardcoded 4-column layout exactly, so
  // existing installs see no visible change until they open Configure.
  listColumns: ['flight', 'typeCode', 'altBaro', 'gs'],
  listSortLevels: [{ key: 'flight', asc: true }],
  listPositionFirst: false,
  // Side panel width in px (desktop/tablet layout only, >=900px -- see
  // panels.js's drag-to-resize handle). Matches the old fixed CSS value, so
  // nobody who hasn't dragged the handle sees any visual change.
  sidePanelWidth: 440,
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
