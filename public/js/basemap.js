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
    airport: '#e0b84a',
    airportText: '#e8e2cc',
    airportHalo: '#05070a',
  },
  light: {
    background: '#eef1ec',
    coastline: '#2f6b4f',
    borders: '#35506b',
    rivers: '#1f4f73',
    cityFill: '#1f3d52',
    cityStroke: '#eef1ec',
    airport: '#9a6a00',
    airportText: '#3a2f14',
    airportHalo: '#eef1ec',
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
  addOfflineAirportLayer(map, theme);
}

// Major/mid airports from Natural Earth (scripts/fetch-mapdata.mjs), offline
// mode only -- online mode already gets airports from OpenFreeMap's tiles.
// The offline style has no glyph server (and must not reach for one), so a
// plain text-field is out: each label is drawn onto a canvas by the
// browser's own font stack and handed to MapLibre as an *icon*
// (`styleimagemissing`, generated lazily the first time MapLibre needs a
// given id). An icon-only symbol layer never requests glyphs, and still
// gets MapLibre's own collision handling, so a dense region thins out to
// the most important airports (symbol-sort-key = Natural Earth's rank)
// rather than piling labels on top of each other. The IATA code alone
// until AIRPORT_NAME_ZOOM, code plus name after.
const AIRPORT_LAYER_ID = 'ne-airports';
const AIRPORT_IMAGE_PREFIX = 'mlpr-apt|';
const AIRPORT_MIN_ZOOM = 5;
const AIRPORT_NAME_ZOOM = 8;
const airportImageWatchArmed = new WeakSet();

function addOfflineAirportLayer(map, theme) {
  if (!airportImageWatchArmed.has(map)) {
    airportImageWatchArmed.add(map);
    map.on('styleimagemissing', (event) => {
      if (!event.id.startsWith(AIRPORT_IMAGE_PREFIX) || map.hasImage(event.id)) return;
      const image = drawAirportImage(event.id);
      if (image) map.addImage(event.id, image.data, { pixelRatio: image.pixelRatio });
    });
  }

  const idFor = (withName) => [
    'concat',
    `${AIRPORT_IMAGE_PREFIX}${theme}|`,
    ['to-string', ['get', 'major']],
    '|',
    ['coalesce', ['get', 'code'], ''],
    '|',
    withName ? ['coalesce', ['get', 'name'], ''] : '',
  ];

  map.addSource(AIRPORT_LAYER_ID, { type: 'geojson', data: '/mapdata/airports.geojson' });
  map.addLayer({
    id: AIRPORT_LAYER_ID,
    type: 'symbol',
    source: AIRPORT_LAYER_ID,
    minzoom: AIRPORT_MIN_ZOOM,
    layout: {
      'icon-image': ['step', ['zoom'], idFor(false), AIRPORT_NAME_ZOOM, idFor(true)],
      // The dot is at the image's left edge, not its centre -- anchor
      // there so it sits on the airport's real coordinate.
      'icon-anchor': 'left',
      'icon-offset': [-AIRPORT_DOT_RADIUS_PX - 1, 0],
      'symbol-sort-key': ['get', 'rank'],
    },
  });
}

const AIRPORT_DOT_RADIUS_PX = 4;

// Parses the id built by idFor above: prefix, theme, major, code, name.
function drawAirportImage(id) {
  if (typeof document === 'undefined') return null;
  const [, theme, major, code, name] = id.split('|');
  const palette = OFFLINE_PALETTES[theme] ?? OFFLINE_PALETTES.dark;
  const label = name ? `${code} · ${name}` : code;
  const pixelRatio = Math.max(1, Math.round(globalThis.devicePixelRatio || 1));
  const font = `${major === 'true' ? 600 : 500} 11px system-ui, sans-serif`;

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  ctx.font = font;
  const dotBox = AIRPORT_DOT_RADIUS_PX * 2 + 2;
  const textX = dotBox + 3;
  const width = Math.ceil(textX + ctx.measureText(label).width + 3);
  const height = 16;

  canvas.width = width * pixelRatio;
  canvas.height = height * pixelRatio;
  ctx.scale(pixelRatio, pixelRatio);

  const radius = major === 'true' ? AIRPORT_DOT_RADIUS_PX : AIRPORT_DOT_RADIUS_PX - 1;
  ctx.beginPath();
  ctx.arc(dotBox / 2, height / 2, radius, 0, Math.PI * 2);
  ctx.fillStyle = palette.airport;
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = palette.airportHalo;
  ctx.stroke();

  ctx.font = font;
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = palette.airportHalo;
  ctx.strokeText(label, textX, height / 2);
  ctx.fillStyle = palette.airportText;
  ctx.fillText(label, textX, height / 2);

  return { data: ctx.getImageData(0, 0, canvas.width, canvas.height), pixelRatio };
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

// The style a *secondary*, short-lived map (the trigger-area editor) should
// use, given the user's configured mode/theme -- without touching any of
// this module's fallback state machine. Deliberately not applyBasemapMode:
// that function owns module-level state (errorWatchArmed, currentTheme,
// currentCallbacks) scoped to the one long-lived main map, and pointing it
// at a second map would let a transient editor map overwrite the callbacks
// the main map's own error watcher fires with. Instead the editor gets a
// plain style and simply inherits whatever online/offline verdict the main
// map already reached this session -- if online was already found
// unreachable, there's no reason to make the editor probe it again.
export function styleForSecondaryMap(mode, theme) {
  const effective = mode === 'online' && !onlineFailedThisSession ? 'online' : 'offline';
  return { effective, style: effective === 'online' ? onlineStyleUrl(theme) : blankStyle(theme) };
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
