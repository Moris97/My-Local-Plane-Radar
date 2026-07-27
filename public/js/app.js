import { createPlaneElement, setPlaneHeading, setPlaneColor, setPlaneKind, setPlaneLabel } from './aircraft-icon.js';
import { applyBasemapMode, BLANK_STYLE } from './basemap.js';
import { recordPosition, clearHistory, trailFeaturesFor, seedHistory, setShorterTrails, colorForAltitude } from './trail.js';
import { colorForElapsed, colorForSpeed } from './aircraft-color.js';
import { t } from './i18n.js';
import {
  noteAircraft,
  removeAircraft,
  clearAircraft,
  notifyAircraftChanged,
  noteLiveStats,
  setSelectRequestHandler,
  setInspectedHex,
  setSelectedHex,
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
const DAYLIGHT_POLL_INTERVAL_MS = 10 * 60 * 1000;
// Below this zoom, dozens of overlapping labels would be pure noise rather
// than useful -- matches the "at appropriate zoom levels" behavior other
// ADS-B radar UIs default to.
const LABEL_MIN_ZOOM = 7;

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
  renderTrail();
  updateAttributionVisibility(effective);
}

// mapTheme 'auto' follows sunrise/sunset at the receiver. The daylight
// decision is made server-side (server/src/daylight.js) so the receiver's
// coordinates never have to be handed to the browser -- /api/daylight
// answers with just a boolean. `null` means no home location is configured,
// in which case there's nothing to compute from and the OS light/dark
// preference is the best available answer.
let cachedIsDaylight = null;

async function refreshDaylight() {
  try {
    const response = await fetch('/api/daylight');
    if (!response.ok) return;
    cachedIsDaylight = (await response.json()).isDaylight;
  } catch {
    // Offline/unreachable -- keep the last known value rather than flapping.
  }
}

function resolveMapTheme(mapTheme) {
  if (mapTheme !== 'auto') return mapTheme;
  if (cachedIsDaylight === null) {
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return cachedIsDaylight ? 'light' : 'dark';
}

// `theme` here is always a concrete 'light'/'dark' -- 'auto' is resolved by
// the caller, and lastRequestedMapTheme tracks the *resolved* value so an
// automatic sunset flip is correctly detected as a change.
async function switchBasemap(mode, theme) {
  lastRequestedBasemapMode = mode;
  lastRequestedMapTheme = theme;
  // Drives .mlpr-plane-label's colors (style.css) -- deliberately the
  // *map's* resolved theme, not the app's own always-dark UI theme, so
  // labels stay readable against whichever basemap is actually showing.
  // Set synchronously here (not inside onStyleLoaded) so labels don't lag a
  // beat behind an automatic sunset/sunrise flip while tiles are still
  // loading.
  map.getContainer().classList.toggle('mlpr-map-theme-dark', theme === 'dark');
  map.getContainer().classList.toggle('mlpr-map-theme-light', theme === 'light');
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

function applyIconSize(sizePx) {
  document.documentElement.style.setProperty('--mlpr-plane-size', `${sizePx}px`);
}

// Home marker: a small pulsing dot at the receiver's location, toggleable
// (Settings -> Map). Reuses GET /api/settings, the same endpoint the
// Server tab's own home-location field already calls -- which means this
// marker is subject to the exact same access control as that field: if a
// Settings password is set, browsers without a valid session simply won't
// see it (the fetch 401s and is treated the same as "no home configured"),
// consistent with home location being Server-tab-gated everywhere else
// rather than a special case.
let homeMarker = null;
let homeLocation = null; // { lat, lon } | null -- null also covers "not configured" and "not authorized"

async function refreshHomeLocation() {
  try {
    const response = await fetch('/api/settings');
    if (response.ok) {
      const data = await response.json();
      homeLocation =
        typeof data.homeLat === 'number' && typeof data.homeLon === 'number'
          ? { lat: data.homeLat, lon: data.homeLon }
          : null;
    }
  } catch {
    // Offline/unreachable -- keep whatever we last knew rather than flapping.
  }
  updateHomeMarker();
}

function homeMarkerElement() {
  const el = document.createElement('div');
  el.className = 'mlpr-home-marker';
  // Two rings on staggered delays for a continuous outward pulse, plus a
  // solid center dot. transform/opacity (not r/cx/cy) so the animation
  // works the same everywhere without relying on animating SVG geometry
  // properties directly.
  el.innerHTML = `
    <svg viewBox="0 0 40 40" width="40" height="40">
      <circle class="mlpr-home-ring" cx="20" cy="20" r="4"/>
      <circle class="mlpr-home-ring mlpr-home-ring-delay" cx="20" cy="20" r="4"/>
      <circle class="mlpr-home-dot" cx="20" cy="20" r="4"/>
    </svg>
  `;
  return el;
}

function updateHomeMarker() {
  const { showHomeMarker } = getSettings();
  if (!homeLocation || !showHomeMarker) {
    homeMarker?.remove();
    homeMarker = null;
    return;
  }
  const lngLat = [homeLocation.lon, homeLocation.lat];
  if (!homeMarker) {
    homeMarker = new maplibregl.Marker({ element: homeMarkerElement() }).setLngLat(lngLat).addTo(map);
  } else {
    homeMarker.setLngLat(lngLat);
  }
}

// One class toggle on the map container rather than touching every marker
// on every zoom tick -- style.css's .mlpr-labels-hidden rule does the rest.
function updateLabelZoomVisibility() {
  map.getContainer().classList.toggle('mlpr-labels-hidden', map.getZoom() < LABEL_MIN_ZOOM);
}
map.on('zoom', updateLabelZoomVisibility);

map.on('load', async () => {
  updateLabelZoomVisibility();
  const initialSettings = getSettings();
  setShorterTrails(initialSettings.shorterTrails);
  applyIconSize(initialSettings.aircraftIconSize);
  if (initialSettings.mapTheme === 'auto') await refreshDaylight();
  await switchBasemap(initialSettings.basemapMode, resolveMapTheme(initialSettings.mapTheme));
  mapReady = true;
  for (const snapshot of pendingMessages.splice(0)) {
    handleSnapshot(snapshot);
  }
  refreshTrailForSettings();
  refreshHomeLocation();
});

// Re-check daylight periodically so an open tab flips itself at sunset/
// sunrise without needing a reload. 10 minutes is plenty of precision for a
// day/night switch and costs one tiny request per tab.
setInterval(async () => {
  const { mapTheme, basemapMode } = getSettings();
  if (mapTheme !== 'auto') return;
  await refreshDaylight();
  const resolved = resolveMapTheme(mapTheme);
  if (resolved !== lastRequestedMapTheme) switchBasemap(basemapMode, resolved);
}, DAYLIGHT_POLL_INTERVAL_MS);

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
  const { basemapMode, mapTheme, shorterTrails, aircraftIconSize } = getSettings();
  setShorterTrails(shorterTrails);
  applyIconSize(aircraftIconSize);
  if (mapTheme === 'auto' && cachedIsDaylight === null) {
    // Just switched to auto and we've never asked -- fetch, then re-run this
    // same handler's theme check via updateSettings-free direct call.
    refreshDaylight().then(() => {
      const resolved = resolveMapTheme('auto');
      if (resolved !== lastRequestedMapTheme) switchBasemap(getSettings().basemapMode, resolved);
    });
  }
  const resolvedTheme = resolveMapTheme(mapTheme);
  if (basemapMode !== lastRequestedBasemapMode || resolvedTheme !== lastRequestedMapTheme) {
    switchBasemap(basemapMode, resolvedTheme);
  }
  // Self-heals a never-succeeded first fetch (e.g. toggled on before the
  // initial map.on('load') request finished, or that request failed) --
  // otherwise re-enabling the setting would do nothing until reload.
  if (getSettings().showHomeMarker && homeLocation === null) {
    refreshHomeLocation();
  } else {
    updateHomeMarker();
  }
  const { aircraftLabelFields, units } = getSettings();
  for (const state of aircraftState.values()) {
    if (state.marker && state.lastAircraft) {
      state.marker.getElement().style.display = passesAltitudeFilter(state.lastAircraft) ? '' : 'none';
      // Recolor immediately rather than waiting for this aircraft's next
      // update (or the next signalLoss-mode tick, which won't fire at all
      // for the other two modes) -- switching the mode in Settings should
      // repaint every currently-visible marker right away.
      setPlaneColor(state.marker.getElement(), colorForAircraft(state.lastAircraft, Date.now() - state.lastUpdateAt));
      // Same idea for labels -- toggling a field checkbox should relabel
      // every marker immediately, not wait for its next position update.
      setPlaneLabel(state.marker.getElement(), buildAircraftLabel(state.lastAircraft, aircraftLabelFields, units));
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

  const { trailMode } = getSettings();
  let features = [];

  if (trailMode === 'all') {
    for (const hex of aircraftState.keys()) {
      if (!isCurrentlyTracked(hex)) continue;
      features = features.concat(trailFeaturesFor(hex));
    }
  } else if (selectedHex && isCurrentlyTracked(selectedHex)) {
    features = trailFeaturesFor(selectedHex);
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
  const { trailMode } = getSettings();
  if (trailMode === 'all') {
    await loadAllTrails();
  } else if (trailMode === 'click' && selectedHex) {
    await loadTrailForHex(selectedHex);
  }
  renderTrail();
}

// Settings -> Aircraft's per-field checkboxes (aircraftLabelFields) build
// this up piece by piece; an aircraft with none of the enabled fields
// available (e.g. altitude enabled but not yet decoded) just contributes
// nothing rather than a placeholder, same philosophy as the details panel's
// tiles. All-false (or all-empty) naturally returns '' -- setPlaneLabel
// writes that straight into the label div, and :empty in CSS hides it.
function buildAircraftLabel(aircraft, fields, units) {
  const parts = [];
  if (fields.flight) parts.push((aircraft.flight || '').trim() || aircraft.hex);
  if (fields.type && aircraft.typeCode) parts.push(aircraft.typeCode);
  if (fields.altitude) {
    const altitude = aircraft.onGround ? t('onGround') : formatAltitude(aircraft.altBaro, units);
    if (altitude) parts.push(altitude);
  }
  if (fields.speed) {
    const speed = formatSpeed(aircraft.gs, units);
    if (speed) parts.push(speed);
  }
  return parts.join(' · ');
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
  // Default offset is 0, so the popup's tip sits exactly on the aircraft's
  // coordinate -- since the marker (.mlpr-plane) is centered on that same
  // point, the box would end up covering half the icon. A flat pixel offset
  // pushes it clear of the marker on whichever side MapLibre auto-picks,
  // reading as "floating just above the plane". Derived from the
  // user-adjustable icon size (not a fixed constant) so it still clears the
  // marker at any size setting.
  const popupOffset = Math.round(getSettings().aircraftIconSize / 2) + 7;
  activePopup = new maplibregl.Popup({ closeButton: true, closeOnClick: false, offset: popupOffset })
    .setLngLat(state.lastLngLat)
    .setHTML(
      `<div class="mlpr-popup">${formatAircraftInfo(state.lastAircraft)}` +
        `<br><button type="button" id="mlpr-more-details">${t('showMoreDetails')}</button></div>`,
    )
    .addTo(map);
}

async function selectAircraft(hex) {
  selectedHex = hex;
  setSelectedHex(hex);
  if (getSettings().trailMode === 'click') {
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
  setSelectedHex(null);
  renderTrail();
  activePopup?.remove();
  activePopup = null;
}

// Three mutually-exclusive plane color modes (Settings -> Aircraft):
// 'signalLoss' (default) reflects data freshness, fading toward red the
// longer an aircraft goes without an update -- this is the only mode tied
// to elapsed time rather than a flight parameter, and the periodic tick
// below only recolors for staleness when this mode is active. The other
// two are static per-update snapshots of a flight parameter and reuse the
// same gradients already built for trails/elsewhere rather than inventing
// a third palette.
function colorForAircraft(aircraft, elapsedMs) {
  const { planeColorMode } = getSettings();
  if (planeColorMode === 'altitude') return colorForAltitude(aircraft.onGround ? 0 : aircraft.altBaro);
  if (planeColorMode === 'speed') return colorForSpeed(aircraft.gs);
  return colorForElapsed(elapsedMs, FADE_START_MS, FADE_END_MS);
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

  const { aircraftLabelFields, units } = getSettings();
  setPlaneKind(state.marker.getElement(), aircraft);
  setPlaneHeading(state.marker.getElement(), aircraft.track);
  setPlaneColor(state.marker.getElement(), colorForAircraft(aircraft, 0));
  setPlaneLabel(state.marker.getElement(), buildAircraftLabel(aircraft, aircraftLabelFields, units));
  state.marker.getElement().style.display = passesAltitudeFilter(aircraft) ? '' : 'none';

  state.lastUpdateAt = now;
  state.lastLngLat = lngLat;
  state.lastAircraft = aircraft;
  state.goneAt = null;

  const { trailMode } = getSettings();
  if (trailMode === 'all' || aircraft.hex === selectedHex) {
    recordPosition(aircraft.hex, lngLat, aircraft.onGround ? 0 : aircraft.altBaro, now, wasGone);
    renderTrail();
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
    notifyAircraftChanged();
  } else if (snapshot.type === 'delta') {
    for (const aircraft of snapshot.updated) {
      applyAircraftUpdate(aircraft);
    }
    notifyAircraftChanged();
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
  let anyRemoved = false;
  const { planeColorMode } = getSettings();

  for (const [hex, state] of aircraftState) {
    if (state.goneAt !== null) {
      if (now - state.goneAt > FORGET_MS) {
        aircraftState.delete(hex);
        clearHistory(hex);
        removeAircraft(hex);
        anyRemoved = true;
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

    // Only the 'signalLoss' mode depends on elapsed time -- the other modes
    // are static snapshots of a flight parameter already set at update time
    // (see colorForAircraft), so skip the recolor entirely rather than
    // writing the same color to the DOM on every tick for no reason.
    if (state.marker && planeColorMode !== 'altitude' && planeColorMode !== 'speed') {
      setPlaneColor(state.marker.getElement(), colorForAircraft(state.lastAircraft, elapsed));
    }
  }

  if (trailNeedsRefresh) renderTrail();
  if (anyRemoved) notifyAircraftChanged();
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
