import { createPlaneElement, setPlaneHeading, setPlaneColor } from './aircraft-icon.js';
import { applyBasemapMode, getBasemapLayerIds, BLANK_STYLE } from './basemap.js';
import { recordPosition, clearHistory, trailFeaturesFor, seedHistory } from './trail.js';
import { t } from './i18n.js';
import {
  noteAircraft,
  removeAircraft,
  clearAircraft,
  noteLiveStats,
  setSelectRequestHandler,
} from './radar-state.js';
import { getSettings, onSettingsChange } from './settings-state.js';
import './panels.js';

const DEFAULT_CENTER = [0, 0];
const DEFAULT_ZOOM = 2;

const FADE_START_MS = 3000;
const FADE_END_MS = 10000;
const REMOVE_MS = 20000;
const FORGET_MS = 5 * 60 * 1000;
const TICK_INTERVAL_MS = 300;

const FRESH_COLOR = [61, 220, 132]; // #3ddc84
const STALE_COLOR = [224, 49, 49]; // #e03131

const TRAIL_SOURCE_ID = 'mlpr-trail';

const map = new maplibregl.Map({
  container: 'map',
  style: BLANK_STYLE,
  center: DEFAULT_CENTER,
  zoom: DEFAULT_ZOOM,
  attributionControl: false,
});

map.dragRotate.disable();
map.touchZoomRotate.disableRotation();

const aircraftState = new Map();
let hasCentered = false;
let mapReady = false;
let selectedHex = null;
let activePopup = null;
const pendingMessages = [];

// The effective mode actually rendered (may differ from getSettings().basemapMode
// while a same-session fallback to offline is active — see basemap.js).
let effectiveBasemapMode = null;
// The basemapMode setting value switchBasemap() was last called with, so the
// settings-change listener only reacts when that specific setting changes.
let lastRequestedBasemapMode = null;

function ensureTrailLayer() {
  if (map.getSource(TRAIL_SOURCE_ID)) return;
  map.addSource(TRAIL_SOURCE_ID, {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  });
  map.addLayer({
    id: TRAIL_SOURCE_ID,
    type: 'line',
    source: TRAIL_SOURCE_ID,
    paint: {
      'line-color': ['get', 'color'],
      'line-width': 2.5,
    },
  });
}

function updateAttributionVisibility(mode) {
  // The MapLibre credit stays visible in both modes; only the OSM data
  // credit is online-only (offline mode uses public-domain Natural Earth
  // data, which needs no attribution).
  document.getElementById('mlpr-osm-attribution')?.classList.toggle('hidden', mode !== 'online');
}

function onBasemapEffectiveModeReady(effective) {
  effectiveBasemapMode = effective;
  ensureTrailLayer();
  applyLayerVisibility();
  renderTrail();
  updateAttributionVisibility(effective);
}

async function switchBasemap(mode) {
  lastRequestedBasemapMode = mode;
  await applyBasemapMode(
    map,
    mode,
    {
      onStyleLoaded: onBasemapEffectiveModeReady,
      onFallback: onBasemapEffectiveModeReady,
    },
    { resetFallback: true },
  );
}

map.on('load', async () => {
  await switchBasemap(getSettings().basemapMode);
  mapReady = true;
  for (const snapshot of pendingMessages.splice(0)) {
    handleSnapshot(snapshot);
  }
  refreshTrailForSettings();
});

function applyLayerVisibility() {
  const { layers } = getSettings();
  const basemapVisibility = layers.basemap ? 'visible' : 'none';
  for (const id of getBasemapLayerIds(effectiveBasemapMode)) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', basemapVisibility);
  }
}

function passesAltitudeFilter(aircraft) {
  if (aircraft.onGround) return true;
  const alt = aircraft.altBaro;
  if (typeof alt !== 'number') return true;
  const { altitudeFilterMin, altitudeFilterMax } = getSettings();
  if (altitudeFilterMin !== null && alt < altitudeFilterMin) return false;
  if (altitudeFilterMax !== null && alt > altitudeFilterMax) return false;
  return true;
}

onSettingsChange(() => {
  const { basemapMode } = getSettings();
  if (basemapMode !== lastRequestedBasemapMode) {
    switchBasemap(basemapMode);
  }
  applyLayerVisibility();
  for (const state of aircraftState.values()) {
    if (state.marker && state.lastAircraft) {
      state.marker.getElement().style.display = passesAltitudeFilter(state.lastAircraft) ? '' : 'none';
    }
  }
  refreshTrailForSettings();
});

map.on('click', () => {
  deselectAircraft();
});

document.addEventListener('click', (event) => {
  if (event.target?.id === 'mlpr-more-details') {
    activePopup?.remove();
    activePopup = null;
  }
});

function renderTrail() {
  const source = map.getSource(TRAIL_SOURCE_ID);
  if (!source) return;

  const { trailsEnabled, trailMode } = getSettings();
  let features = [];

  if (trailsEnabled) {
    if (trailMode === 'all') {
      for (const hex of aircraftState.keys()) {
        features = features.concat(trailFeaturesFor(hex));
      }
    } else if (selectedHex) {
      features = trailFeaturesFor(selectedHex);
    }
  }

  source.setData({ type: 'FeatureCollection', features });
}

async function loadTrailForHex(hex) {
  try {
    const response = await fetch(`/api/trails/${hex}`);
    if (!response.ok) return;
    seedHistory(hex, await response.json());
  } catch {
    // fine — trail just starts empty and builds up live from here
  }
}

async function loadAllTrails() {
  try {
    const response = await fetch('/api/trails');
    if (!response.ok) return;
    const trails = await response.json();
    for (const [hex, points] of Object.entries(trails)) {
      seedHistory(hex, points);
    }
  } catch {
    // fine — trails just start empty and build up live from here
  }
}

async function refreshTrailForSettings() {
  const { trailsEnabled, trailMode } = getSettings();
  if (trailsEnabled && trailMode === 'all') {
    await loadAllTrails();
  } else if (trailsEnabled && trailMode === 'click' && selectedHex) {
    await loadTrailForHex(selectedHex);
  }
  renderTrail();
}

function formatAircraftInfo(aircraft) {
  const lines = [aircraft.flight || aircraft.hex];
  if (aircraft.typeCode) lines.push(`${t('type')}: ${aircraft.typeCode}`);
  if (aircraft.onGround) {
    lines.push(t('onGround'));
  } else if (typeof aircraft.altBaro === 'number') {
    lines.push(`${t('altitude')}: ${aircraft.altBaro} ft`);
  }
  if (typeof aircraft.gs === 'number') lines.push(`${t('speed')}: ${Math.round(aircraft.gs)} kt`);
  return lines.join('<br>');
}

function showInfoPopup(hex) {
  const state = aircraftState.get(hex);
  if (!state || !state.lastLngLat || !state.lastAircraft) return;

  activePopup?.remove();
  activePopup = new maplibregl.Popup({ closeButton: true, closeOnClick: false })
    .setLngLat(state.lastLngLat)
    .setHTML(
      `<div class="mlpr-popup">${formatAircraftInfo(state.lastAircraft)}` +
        `<br><button type="button" id="mlpr-more-details">${t('showMoreDetails')}</button></div>`,
    )
    .addTo(map);
}

async function selectAircraft(hex) {
  selectedHex = hex;
  const { trailsEnabled, trailMode } = getSettings();
  if (trailsEnabled && trailMode === 'click') {
    await loadTrailForHex(hex);
  }
  renderTrail();
  showInfoPopup(hex);
}

function selectAndCenter(hex) {
  const state = aircraftState.get(hex);
  if (state?.lastLngLat) {
    map.flyTo({ center: state.lastLngLat });
  }
  selectAircraft(hex);
}

setSelectRequestHandler(selectAndCenter);

function deselectAircraft() {
  selectedHex = null;
  renderTrail();
  activePopup?.remove();
  activePopup = null;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function colorForElapsed(elapsedMs) {
  if (elapsedMs <= FADE_START_MS) {
    return `rgb(${FRESH_COLOR.join(',')})`;
  }
  const t = Math.min(1, (elapsedMs - FADE_START_MS) / (FADE_END_MS - FADE_START_MS));
  const r = Math.round(lerp(FRESH_COLOR[0], STALE_COLOR[0], t));
  const g = Math.round(lerp(FRESH_COLOR[1], STALE_COLOR[1], t));
  const b = Math.round(lerp(FRESH_COLOR[2], STALE_COLOR[2], t));
  return `rgb(${r},${g},${b})`;
}

function resetAll() {
  for (const state of aircraftState.values()) {
    state.marker?.remove();
  }
  aircraftState.clear();
  hasCentered = false;
  deselectAircraft();
  clearAircraft();
}

function applyAircraftUpdate(aircraft) {
  if (typeof aircraft.lat !== 'number' || typeof aircraft.lon !== 'number') {
    return;
  }

  const lngLat = [aircraft.lon, aircraft.lat];
  const now = Date.now();
  let state = aircraftState.get(aircraft.hex);

  if (!state) {
    state = { marker: null, lastUpdateAt: now, lastLngLat: lngLat, goneAt: null };
    aircraftState.set(aircraft.hex, state);
  }

  const wasGone = state.goneAt !== null;

  if (!state.marker) {
    state.marker = new maplibregl.Marker({ element: createPlaneElement() }).setLngLat(lngLat).addTo(map);
    state.marker.getElement().addEventListener('click', (event) => {
      event.stopPropagation();
      selectAircraft(aircraft.hex);
    });
  } else {
    state.marker.setLngLat(lngLat);
  }

  setPlaneHeading(state.marker.getElement(), aircraft.track);
  setPlaneColor(state.marker.getElement(), colorForElapsed(0));
  state.marker.getElement().style.display = passesAltitudeFilter(aircraft) ? '' : 'none';

  state.lastUpdateAt = now;
  state.lastLngLat = lngLat;
  state.lastAircraft = aircraft;
  state.goneAt = null;

  const { trailsEnabled, trailMode } = getSettings();
  const shouldTrackTrail = trailsEnabled && (trailMode === 'all' || aircraft.hex === selectedHex);
  if (shouldTrackTrail) {
    recordPosition(aircraft.hex, lngLat, aircraft.onGround ? 0 : aircraft.altBaro, now, wasGone);
    if (trailMode === 'all' || aircraft.hex === selectedHex) {
      renderTrail();
    }
  }

  noteAircraft(aircraft.hex, aircraft);

  if (aircraft.hex === selectedHex) {
    showInfoPopup(aircraft.hex);
  }

  if (!hasCentered) {
    map.jumpTo({ center: lngLat, zoom: 9 });
    hasCentered = true;
  }
}

function handleSnapshot(snapshot) {
  if (snapshot.type === 'full') {
    resetAll();
    for (const aircraft of snapshot.aircraft) {
      applyAircraftUpdate(aircraft);
    }
  } else if (snapshot.type === 'delta') {
    for (const aircraft of snapshot.updated) {
      applyAircraftUpdate(aircraft);
    }
  } else if (snapshot.type === 'stats') {
    noteLiveStats({
      aircraftCount: snapshot.aircraftCount,
      messagesPerSec: snapshot.messagesPerSec,
      maxRangeKm: snapshot.maxRangeKm,
    });
  }
}

setInterval(() => {
  const now = Date.now();

  for (const [hex, state] of aircraftState) {
    if (state.goneAt !== null) {
      if (now - state.goneAt > FORGET_MS) {
        aircraftState.delete(hex);
        clearHistory(hex);
        removeAircraft(hex);
        if (hex === selectedHex) deselectAircraft();
      }
      continue;
    }

    const elapsed = now - state.lastUpdateAt;

    if (elapsed >= REMOVE_MS) {
      state.marker?.remove();
      state.marker = null;
      state.goneAt = now;
      continue;
    }

    if (state.marker) {
      setPlaneColor(state.marker.getElement(), colorForElapsed(elapsed));
    }
  }
}, TICK_INTERVAL_MS);

function connect() {
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${protocol}://${location.host}/ws`);

  ws.addEventListener('message', (event) => {
    const snapshot = JSON.parse(event.data);
    if (mapReady) {
      handleSnapshot(snapshot);
    } else {
      pendingMessages.push(snapshot);
    }
  });

  ws.addEventListener('close', () => {
    setTimeout(connect, 1000);
  });

  ws.addEventListener('error', () => ws.close());
}

connect();
