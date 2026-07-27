const STORAGE_KEY = 'mlpr-settings';

const defaults = {
  units: 'imperial',
  altitudeFilterMin: null,
  altitudeFilterMax: null,
  layers: { basemap: true },
  basemapMode: 'online', // 'online' (OpenFreeMap) | 'offline' (Natural Earth)
  mapTheme: 'dark', // 'dark' | 'light' — map style only, not the app's own UI theme
  trailsEnabled: true,
  trailMode: 'click', // 'click' | 'all'
  shorterTrails: false, // performance option: cap client-side trail length lower than the server default
  aircraftIconSize: 40, // px, side of the .mlpr-plane marker
  planeColorMode: 'signalLoss', // 'signalLoss' | 'altitude' | 'speed'
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
