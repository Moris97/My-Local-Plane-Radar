import { createPlaneElement, setPlaneHeading, setPlaneColor, setPlaneKind } from './aircraft-icon.js';
import { applyBasemapMode, getBasemapLayerIds, BLANK_STYLE } from './basemap.js';
import { recordPosition, clearHistory, trailFeaturesFor, seedHistory, setShorterTrails } from './trail.js';
import { t } from './i18n.js';
import {
  noteAircraft,
  removeAircraft,
  clearAircraft,
  noteLiveStats,
  setSelectRequestHandler,
  setInspectedHex,
} from './radar-state.js';
import { getSettings, onSettingsChange } from './settings-state.js';
import { openPanel } from './panels.js';
import { formatAltitude, formatSpeed } from './units.js';

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
const TRAIL_GAP_LAYER_ID = 'mlpr-trail-gap';

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
// The basemapMode/mapTheme setting values switchBasemap() was last called
// with, so the settings-change listener only reacts when either changes.
let lastRequestedBasemapMode = null;
let lastRequestedMapTheme = null;

function ensureTrailLayer() {
  if (!map.getSource(TRAIL_SOURCE_ID)) {
    map.addSource(TRAIL_SOURCE_ID, {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
      // The trail can't be one single polyline (each stretch carries its own
      // altitude color), so it is split into per-color runs. With the default
      // tolerance, MapLibre's internal tile simplification (geojson-vt) can
      // collapse very short runs below its pixel tolerance at low zoom,
      // making them disappear -- reported as "gaps that appear zoomed out,
      // vanish zoomed in", which is the textbook symptom of this.
      // tolerance: 0 disables that simplification so short runs always
      // render regardless of zoom.
      tolerance: 0,
    });
  }

  // Two layers over one shared source: solid altitude-colored trail, plus a
  // dashed layer for signal-loss bridge segments. Splitting them is forced
  // by MapLibre -- line-dasharray is not data-driven, so "dashed only for
  // gaps" cannot be expressed as an expression on a single layer. Note this
  // is deliberately still ONE source fed only by renderTrail(): the old bug
  // was a separate always-populated gap *source* that drew grey trails for
  // unselected aircraft, which a second layer over the shared source does
  // not reintroduce.
  if (!map.getLayer(TRAIL_SOURCE_ID)) {
    map.addLayer({
      id: TRAIL_SOURCE_ID,
      type: 'line',
      source: TRAIL_SOURCE_ID,
      filter: ['!=', ['get', 'isGap'], true],
      // Round caps/joins let consecutive runs overlap slightly instead of
      // meeting at butt ends, closing the hairline seams that read as a
      // dashed line when zoomed out.
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': ['get', 'color'],
        'line-width': 3.5,
      },
    });
  }

  if (!map.getLayer(TRAIL_GAP_LAYER_ID)) {
    map.addLayer({
      id: TRAIL_GAP_LAYER_ID,
      type: 'line',
      source: TRAIL_SOURCE_ID,
      filter: ['==', ['get', 'isGap'], true],
      layout: { 'line-cap': 'butt', 'line-join': 'round' },
      paint: {
        'line-color': ['get', 'color'],
        // Deliberately thinner and slightly translucent compared to the
        // solid trail: a stretch with no data should read as a faint
        // placeholder, not as a feature competing with real track.
        'line-width': 2,
        'line-opacity': 0.85,
        // Dash units are multiples of line-width, so this is a 5px dash /
        // 5px gap -- fine enough to look delicate at any zoom.
        'line-dasharray': [2.5, 2.5],
      },
    });
  }
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

async function switchBasemap(mode, theme) {
  lastRequestedBasemapMode = mode;
  lastRequestedMapTheme = theme;
  await applyBasemapMode(
    map,
    mode,
    theme,
    {
      onStyleLoaded: onBasemapEffectiveModeReady,
      onFallback: onBasemapEffectiveModeReady,
    },
    { resetFallback: true },
  );
}

map.on('load', async () => {
  const initialSettings = getSettings();
  setShorterTrails(initialSettings.shorterTrails);
  await switchBasemap(initialSettings.basemapMode, initialSettings.mapTheme);
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
  const { basemapMode, mapTheme, shorterTrails } = getSettings();
  setShorterTrails(shorterTrails);
  if (basemapMode !== lastRequestedBasemapMode || mapTheme !== lastRequestedMapTheme) {
    switchBasemap(basemapMode, mapTheme);
  }
  applyLayerVisibility();
  for (const state of aircraftState.values()) {
    if (state.marker && state.lastAircraft) {
      state.marker.getElement().style.display = passesAltitudeFilter(state.lastAircraft) ? '' : 'none';
    }
  }
  refreshTrailForSettings();
  if (selectedHex) showInfoPopup(selectedHex);
});

map.on('click', () => {
  deselectAircraft();
});

document.addEventListener('click', (event) => {
  if (event.target?.id === 'mlpr-more-details') {
    const hex = selectedHex;
    activePopup?.remove();
    activePopup = null;
    if (hex) {
      setInspectedHex(hex);
      openPanel('aircraft');
    }
  }
});

// A "gone" aircraft (marker already removed, state.goneAt set -- see the
// REMOVE_MS handling below) is kept around in aircraftState/trail history
// for up to FORGET_MS purely so a reappearance can be linked with a grey
// gap segment. Its trail must not keep rendering on the map for that whole
// window, though -- previously it stayed visible for up to 5 minutes after
// the plane icon itself had already vanished.
function isCurrentlyTracked(hex) {
  return aircraftState.get(hex)?.goneAt === null;
}

function renderTrail() {
  const source = map.getSource(TRAIL_SOURCE_ID);
  if (!source) return;

  const { trailsEnabled, trailMode } = getSettings();
  let features = [];

  if (trailsEnabled) {
    if (trailMode === 'all') {
      for (const hex of aircraftState.keys()) {
        if (!isCurrentlyTracked(hex)) continue;
        features = features.concat(trailFeaturesFor(hex));
      }
    } else if (selectedHex && isCurrentlyTracked(selectedHex)) {
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
  const { units } = getSettings();
  const lines = [aircraft.flight || aircraft.hex];
  if (aircraft.typeCode) lines.push(`${t('type')}: ${aircraft.typeCode}`);
  if (aircraft.onGround) {
    lines.push(t('onGround'));
  } else {
    const altitude = formatAltitude(aircraft.altBaro, units);
    if (altitude) lines.push(`${t('altitude')}: ${altitude}`);
  }
  const speed = formatSpeed(aircraft.gs, units);
  if (speed) lines.push(`${t('speed')}: ${speed}`);
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
    state.marker = new maplibregl.Marker({ element: createPlaneElement(aircraft) }).setLngLat(lngLat).addTo(map);
    state.marker.getElement().addEventListener('click', (event) => {
      event.stopPropagation();
      selectAircraft(aircraft.hex);
    });
  } else {
    state.marker.setLngLat(lngLat);
  }

  setPlaneKind(state.marker.getElement(), aircraft);
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
  let trailNeedsRefresh = false;

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
      // The trail must stop rendering right when the icon disappears, not
      // whenever some other aircraft's update happens to next trigger a
      // redraw (see isCurrentlyTracked() in renderTrail()).
      trailNeedsRefresh = true;
      continue;
    }

    if (state.marker) {
      setPlaneColor(state.marker.getElement(), colorForElapsed(elapsed));
    }
  }

  if (trailNeedsRefresh) renderTrail();
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
