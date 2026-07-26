const OFFLINE_LAYERS = [
  {
    id: 'ne-coastline',
    url: '/mapdata/coastline.geojson',
    type: 'line',
    paint: { 'line-color': '#2f6b4f', 'line-width': 1 },
  },
  {
    id: 'ne-borders',
    url: '/mapdata/borders.geojson',
    type: 'line',
    paint: { 'line-color': '#35506b', 'line-width': 0.75, 'line-dasharray': [4, 3] },
  },
  {
    id: 'ne-rivers',
    url: '/mapdata/rivers.geojson',
    type: 'line',
    paint: { 'line-color': '#1f4f73', 'line-width': 0.75 },
    minzoom: 2,
  },
  {
    id: 'ne-cities',
    url: '/mapdata/cities.geojson',
    type: 'circle',
    paint: {
      'circle-color': '#bcd7e8',
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 3, 2, 8, 4],
      'circle-stroke-color': '#05070a',
      'circle-stroke-width': 0.5,
    },
    minzoom: 2,
  },
];

const OFFLINE_LAYER_IDS = OFFLINE_LAYERS.map((layer) => layer.id);

// Kept in sync by hand with the layer ids in public/mapstyles/online-dark.json
// (excluding 'background', which stays visible regardless of the basemap toggle).
const ONLINE_LAYER_IDS = [
  'water',
  'landcover-wood',
  'landcover-grass',
  'park',
  'landuse-residential',
  'waterway',
  'road-minor',
  'road-secondary-tertiary',
  'road-trunk-primary',
  'road-motorway',
  'road-major-rail',
  'aeroway-fill',
  'aeroway-taxiway',
  'aeroway-runway',
  'boundary-region',
  'boundary-country',
  'airport-label',
  'label-village',
  'label-town',
  'label-city',
  'label-state',
  'label-country',
];

const ONLINE_STYLE_URL = '/mapstyles/online-dark.json';
// Same OpenFreeMap TileJSON our online style's vector source points at — small
// (~1 KB) and the right thing to probe: if this can't be reached, the real
// vector tiles won't load either.
const ONLINE_REACHABILITY_URL = 'https://tiles.openfreemap.org/planet';
const REACHABILITY_TIMEOUT_MS = 6000;

const BLANK_STYLE = {
  version: 8,
  sources: {},
  layers: [
    {
      id: 'background',
      type: 'background',
      paint: { 'background-color': '#05070a' },
    },
  ],
};

export function addOfflineLayers(map) {
  for (const layer of OFFLINE_LAYERS) {
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

export function getBasemapLayerIds(mode) {
  return mode === 'online' ? ONLINE_LAYER_IDS : OFFLINE_LAYER_IDS;
}

// Set once per page load the first time the online basemap fails (preflight
// check or a runtime source error) and never cleared until the page reloads,
// except by an explicit user-initiated retry (resetFallback).
let onlineFailedThisSession = false;
let errorWatchArmed = false;

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
// live again if a later manual retry (resetFallback) clears that flag.
function armOnlineErrorWatch(map, effectiveMode, callbacks) {
  if (effectiveMode !== 'online' || errorWatchArmed) return;
  errorWatchArmed = true;

  map.on('error', (event) => {
    if (onlineFailedThisSession) return;
    if (event.sourceId !== 'openmaptiles' || !looksLikeNetworkFailure(event.error)) return;

    onlineFailedThisSession = true;
    applyBasemapMode(map, 'offline', callbacks).then((effective) => {
      callbacks.onFallback?.(effective);
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

export async function applyBasemapMode(map, mode, callbacks = {}, { resetFallback = false } = {}) {
  if (resetFallback) onlineFailedThisSession = false;

  const effective = await resolveEffectiveMode(mode);

  return new Promise((resolve) => {
    map.once('style.load', () => {
      if (effective === 'offline') addOfflineLayers(map);
      armOnlineErrorWatch(map, effective, callbacks);
      callbacks.onStyleLoaded?.(effective);
      resolve(effective);
    });
    map.setStyle(effective === 'online' ? ONLINE_STYLE_URL : BLANK_STYLE);
  });
}

export { BLANK_STYLE };
