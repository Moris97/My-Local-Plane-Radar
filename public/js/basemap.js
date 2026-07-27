// Per-theme paint values for the offline (Natural Earth) layers. Coastline,
// borders and rivers already read fine on both a near-black and a near-white
// background (they're medium-dark, saturated colors), so only the city dots
// and the background itself actually need to flip between themes.
const OFFLINE_PALETTES = {
  dark: {
    background: '#05070a',
    coastline: '#2f6b4f',
    borders: '#35506b',
    rivers: '#1f4f73',
    cityFill: '#bcd7e8',
    cityStroke: '#05070a',
  },
  light: {
    background: '#eef1ec',
    coastline: '#2f6b4f',
    borders: '#35506b',
    rivers: '#1f4f73',
    cityFill: '#1f3d52',
    cityStroke: '#eef1ec',
  },
};

function buildOfflineLayers(theme) {
  const p = OFFLINE_PALETTES[theme] ?? OFFLINE_PALETTES.dark;
  return [
    {
      id: 'ne-coastline',
      url: '/mapdata/coastline.geojson',
      type: 'line',
      paint: { 'line-color': p.coastline, 'line-width': 1 },
    },
    {
      id: 'ne-borders',
      url: '/mapdata/borders.geojson',
      type: 'line',
      paint: { 'line-color': p.borders, 'line-width': 0.75, 'line-dasharray': [4, 3] },
    },
    {
      id: 'ne-rivers',
      url: '/mapdata/rivers.geojson',
      type: 'line',
      paint: { 'line-color': p.rivers, 'line-width': 0.75 },
      minzoom: 2,
    },
    {
      id: 'ne-cities',
      url: '/mapdata/cities.geojson',
      type: 'circle',
      paint: {
        'circle-color': p.cityFill,
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 3, 2, 8, 4],
        'circle-stroke-color': p.cityStroke,
        'circle-stroke-width': 0.5,
      },
      minzoom: 2,
    },
  ];
}

function onlineStyleUrl(theme) {
  return theme === 'light' ? '/mapstyles/online-light.json' : '/mapstyles/online-dark.json';
}

function blankStyle(theme) {
  const background = (OFFLINE_PALETTES[theme] ?? OFFLINE_PALETTES.dark).background;
  return {
    version: 8,
    sources: {},
    layers: [
      {
        id: 'background',
        type: 'background',
        paint: { 'background-color': background },
      },
    ],
  };
}

// Same OpenFreeMap TileJSON our online styles' vector source points at —
// small (~1 KB) and the right thing to probe: if this can't be reached, the
// real vector tiles won't load either. Independent of light/dark theme.
const ONLINE_REACHABILITY_URL = 'https://tiles.openfreemap.org/planet';
const REACHABILITY_TIMEOUT_MS = 6000;

export function addOfflineLayers(map, theme) {
  for (const layer of buildOfflineLayers(theme)) {
    map.addSource(layer.id, { type: 'geojson', data: layer.url });
    map.addLayer({
      id: layer.id,
      type: layer.type,
      source: layer.id,
      minzoom: layer.minzoom ?? 0,
      paint: layer.paint,
    });
  }
}

// Set once per page load the first time the online basemap fails (preflight
// check or a runtime source error) and never cleared until the page reloads,
// except by an explicit user-initiated retry (resetFallback).
let onlineFailedThisSession = false;
let errorWatchArmed = false;

// The most recently requested theme/callbacks, kept up to date on every
// applyBasemapMode call so the long-lived error listener (armed once, see
// armOnlineErrorWatch) always falls back using the *current* theme rather
// than whatever was active the first time it was armed.
let currentTheme = 'dark';
let currentCallbacks = {};

export function isOnlineFallbackActive() {
  return onlineFailedThisSession;
}

async function checkOnlineReachable() {
  try {
    const response = await fetch(ONLINE_REACHABILITY_URL, {
      cache: 'no-store',
      signal: AbortSignal.timeout(REACHABILITY_TIMEOUT_MS),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function looksLikeNetworkFailure(error) {
  if (!error) return false;
  const status = error.status;
  if (status === 0 || status === 502 || status === 503 || status === 504) return true;
  return /failed to fetch|networkerror|load failed/i.test(String(error.message || ''));
}

// Armed once per map instance (guarded by errorWatchArmed) and left attached
// for the map's lifetime — the listener body re-checks onlineFailedThisSession
// on every call, so it naturally goes dormant after a fallback and becomes
// live again if a later manual retry (resetFallback) clears that flag. It
// reads currentTheme/currentCallbacks at fire time (not closed-over at arm
// time) so it stays correct across theme switches that happen after arming.
function armOnlineErrorWatch(map, effectiveMode) {
  if (effectiveMode !== 'online' || errorWatchArmed) return;
  errorWatchArmed = true;

  map.on('error', (event) => {
    if (onlineFailedThisSession) return;
    if (event.sourceId !== 'openmaptiles' || !looksLikeNetworkFailure(event.error)) return;

    onlineFailedThisSession = true;
    applyBasemapMode(map, 'offline', currentTheme, currentCallbacks).then((effective) => {
      currentCallbacks.onFallback?.(effective);
    });
  });
}

async function resolveEffectiveMode(mode) {
  if (mode !== 'online') return 'offline';
  if (onlineFailedThisSession) return 'offline';
  if (await checkOnlineReachable()) return 'online';
  onlineFailedThisSession = true;
  return 'offline';
}

export async function applyBasemapMode(map, mode, theme, callbacks = {}, { resetFallback = false } = {}) {
  currentTheme = theme;
  currentCallbacks = callbacks;
  if (resetFallback) onlineFailedThisSession = false;

  const effective = await resolveEffectiveMode(mode);

  return new Promise((resolve) => {
    map.once('style.load', () => {
      if (effective === 'offline') addOfflineLayers(map, theme);
      armOnlineErrorWatch(map, effective);
      callbacks.onStyleLoaded?.(effective);
      resolve(effective);
    });
    map.setStyle(effective === 'online' ? onlineStyleUrl(theme) : blankStyle(theme));
  });
}

// The initial style the Map constructor is created with, before settings
// have been read and the first real applyBasemapMode call happens — always
// the dark variant, matching the app's default theme.
export const BLANK_STYLE = blankStyle('dark');
