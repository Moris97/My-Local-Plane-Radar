// Per-browser settings only (localStorage). Anything that must be the same
// for everyone on the LAN -- notification rules, the watch list, the
// Settings password, the server port, the receiver's home location -- lives
// server-side in SQLite instead and is reached over /api/*. See CLAUDE.md's
// "Settings scope" section for which tab is which.
const STORAGE_KEY = 'mlpr-settings';

// Single source of truth for the icon-size slider's range/default, shared
// by settings.js (the actual <input type="range">) and /dev/icons (which
// must preview the real min/default/max, not made-up fixed sizes).
export const ICON_SIZE_MIN = 24;
export const ICON_SIZE_MAX = 64;
export const ICON_SIZE_DEFAULT = 40;

const defaults = {
  units: 'imperial',
  // 'auto' follows the browser's own language (navigator.language) --
  // see i18n.js's detectLanguage. Any other value here is a manual
  // override that wins over that auto-detection. Changing it needs a
  // page reload to actually apply (settings.js's language <select> does
  // this itself right after saving) -- translations are baked into
  // static markup all over the app (button labels, aria-labels,
  // document.documentElement.lang...) at render time, not re-evaluated
  // live, so there's no single place to "just re-render everything" the
  // way a live setting like units can.
  language: 'auto',
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
  aircraftIconSize: ICON_SIZE_DEFAULT, // px, side of the .mlpr-plane marker
  planeColorMode: 'signalLoss', // 'signalLoss' | 'altitude' | 'speed'
  // Which fields appear in the small map label under each aircraft (empty
  // object/all-false = no label at all). Kept minimal by default (just the
  // callsign) so the map stays uncluttered until the user opts into more --
  // see app.js's buildAircraftLabel and aircraft-icon-live.js's setPlaneLabel.
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
  // On by default: a row whose position the map can't draw (Mode-S-only, or
  // a fix too old to plot -- see radar-state.js's positionStaleHexes) is the
  // one kind of row that can't be cross-checked against the map, so it
  // belongs at the bottom rather than interleaved with rows that can.
  listPositionFirst: true,
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
