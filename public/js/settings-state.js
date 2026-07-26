const STORAGE_KEY = 'mlpr-settings';

const defaults = {
  units: 'imperial',
  altitudeFilterMin: null,
  altitudeFilterMax: null,
  layers: { basemap: true },
  trailsEnabled: true,
  trailMode: 'click', // 'click' | 'all'
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
