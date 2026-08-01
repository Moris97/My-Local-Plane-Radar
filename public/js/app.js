import { createPlaneElement, setPlaneHeading, setPlaneColor, setPlaneKind, setPlaneLabel, refreshMarkerSize } from './aircraft-icon-live.js';
import { loadIconTypes } from './icon-classify.js';
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
  setHoveredHex,
  setHoverRequestHandler,
} from './radar-state.js';
import { getSettings, onSettingsChange } from './settings-state.js';
import { openPanel } from './panels.js';
import { formatAltitude, formatSpeed } from './units.js';

// aircraft.flight/typeCode ultimately come from readsb's aircraft.json --
// trusted when read from the local file, but HttpSource fetches the same
// JSON over plain, unauthenticated HTTP (the documented "dev on WSL against
// live data" mode), where anyone else on the LAN can MITM/spoof the
// response. formatAircraftInfo() below builds an HTML string from these
// fields for MapLibre's Popup.setHTML() (= innerHTML), so they need the
// same escaping aircraft-panel.js/stats.js already apply to aircraft data
// everywhere else.
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// [0, 0]/zoom 2 is a deliberately neutral placeholder -- shown only for the
// brief moment before the map's real starting view is picked (home location
// if one is configured, else wherever the first positioned aircraft happens
// to be -- see the map.on('load') handler below). Never a real coordinate.
const DEFAULT_CENTER = [0, 0];
const DEFAULT_ZOOM = 2;
// Shared by both ways the map can pick its initial view (home location, or
// falling back to the first aircraft with a position) so the two read as
// one deliberate "starting zoom" rather than two coincidentally-equal magic
// numbers.
const INITIAL_ZOOM = 9;

const FADE_START_MS = 3000;
const FADE_END_MS = 10000;
const REMOVE_MS = 20000;
const FORGET_MS = 5 * 60 * 1000;
const TICK_INTERVAL_MS = 300;
const DAYLIGHT_POLL_INTERVAL_MS = 10 * 60 * 1000;
// The coverage layer only re-fetches when the setting itself changes (see
// onSettingsChange below) -- with nothing else driving it, a tab left open
// with coverage on would show an increasingly stale shape as new farther
// contacts get recorded server-side, only catching up on a manual reload or
// toggling the setting off and on. Polled instead of pushed over the
// existing WebSocket: this is a coarse, slowly-changing shape (antenna-
// stats.js's per-cell top-5 lists rarely change once an install is a few
// weeks old), not worth a dedicated push channel the way live aircraft
// deltas are.
const COVERAGE_REFRESH_INTERVAL_MS = 15000;
// Below this zoom, dozens of overlapping labels would be pure noise rather
// than useful -- matches the "at appropriate zoom levels" behavior other
// ADS-B radar UIs default to.
const LABEL_MIN_ZOOM = 7;

const TRAIL_SOURCE_ID = 'mlpr-trail';
const TRAIL_GAP_LAYER_ID = 'mlpr-trail-gap';

const COVERAGE_SOURCE_ID = 'mlpr-coverage';
const COVERAGE_FILL_LAYER_ID = 'mlpr-coverage-fill';
const COVERAGE_OUTLINE_LAYER_ID = 'mlpr-coverage-outline';
// Representative altitude (ft) for each antenna-stats.js ALTITUDE_BANDS
// index -- purely so the coverage layer can pick a color from the same
// altitude gradient trails already use (trail.js's colorForAltitude) instead
// of inventing a second palette. The exact number barely matters since
// colorForAltitude interpolates smoothly; each is just a representative
// point inside its band.
const COVERAGE_BAND_MIDPOINT_FT = [2500, 7500, 12500, 17500, 22500, 27500, 32500, 37500, 45000];
// "All altitudes" has no single representative point to feed the gradient,
// so it gets the app's own default accent green instead -- reads as
// "combined", not as a specific rung on the altitude scale.
const COVERAGE_ALL_COLOR = '#3ddc84';

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
// Which marker currently has the .mlpr-plane-hover class applied *because
// the list asked for it* (requestHover, see setHoverRequestHandler below)
// -- tracked separately from hovering the marker directly (that toggles
// the class from its own mouseenter/mouseleave, no bookkeeping needed)
// purely so a later requestHover(null) or a different hex knows which
// element to clear it from.
let lastHoverRequestHex = null;
let activePopup = null;
// Which hex activePopup is currently showing -- lets showInfoPopup tell "the
// selected aircraft's position just updated, refresh the existing popup in
// place" apart from "a different aircraft got selected, need a new popup".
let activePopupHex = null;
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

// Reception coverage overlay (Settings -> Map, off by default): one
// GeoJSON source carrying two polygon features -- "fill" (the outlier-
// resistant top-5-average boundary, server/src/antenna-stats.js) rendered
// as a soft filled shape, and "max" (the honest single best-ever contact
// per direction) rendered as a thin dashed outline around it. Two layers
// over one source, filtered by a `kind` property -- same shape as the
// trail/trail-gap split above, and for the same underlying reason
// (`fill-opacity`/`line-dasharray` aren't things you can vary by feature
// within one layer). Added *before* ensureTrailLayer() in
// onBasemapEffectiveModeReady so trails paint on top of this, not under it.
function ensureCoverageLayer() {
  if (!map.getSource(COVERAGE_SOURCE_ID)) {
    map.addSource(COVERAGE_SOURCE_ID, { type: 'geojson', data: coverageGeoJSON });
  } else {
    // setStyle() (basemap switch) wipes sources/layers -- re-adding the
    // source above starts it empty again, so the last-fetched shape needs
    // to be reapplied rather than waiting for the next settings change.
    map.getSource(COVERAGE_SOURCE_ID).setData(coverageGeoJSON);
  }

  if (!map.getLayer(COVERAGE_FILL_LAYER_ID)) {
    map.addLayer({
      id: COVERAGE_FILL_LAYER_ID,
      type: 'fill',
      source: COVERAGE_SOURCE_ID,
      filter: ['==', ['get', 'kind'], 'fill'],
      paint: {
        'fill-color': ['get', 'color'],
        'fill-opacity': 0.16,
      },
    });
  }

  if (!map.getLayer(COVERAGE_OUTLINE_LAYER_ID)) {
    map.addLayer({
      id: COVERAGE_OUTLINE_LAYER_ID,
      type: 'line',
      source: COVERAGE_SOURCE_ID,
      filter: ['==', ['get', 'kind'], 'max'],
      layout: { 'line-join': 'round' },
      paint: {
        'line-color': ['get', 'color'],
        'line-width': 1.5,
        'line-opacity': 0.55,
        'line-dasharray': [2, 2],
      },
    });
  }
}

function coverageColor(band) {
  return band === 'all' ? COVERAGE_ALL_COLOR : colorForAltitude(COVERAGE_BAND_MIDPOINT_FT[band]);
}

let coverageGeoJSON = { type: 'FeatureCollection', features: [] };
let lastRequestedShowCoverage = null;
let lastRequestedCoverageBand = null;

async function refreshCoverage() {
  const { showCoverage, coverageBand } = getSettings();
  lastRequestedShowCoverage = showCoverage;
  lastRequestedCoverageBand = coverageBand;

  if (!showCoverage) {
    coverageGeoJSON = { type: 'FeatureCollection', features: [] };
    map.getSource(COVERAGE_SOURCE_ID)?.setData(coverageGeoJSON);
    return;
  }

  try {
    const response = await fetch(`/api/stats/antenna/coverage?band=${coverageBand}`);
    if (!response.ok) return; // 401 (Settings password set, not logged in) or offline -- leave whatever was last shown
    const data = await response.json();
    const color = coverageColor(coverageBand);
    coverageGeoJSON =
      data.fillPolygon && data.maxPolygon
        ? {
            type: 'FeatureCollection',
            features: [
              { type: 'Feature', properties: { kind: 'fill', color }, geometry: { type: 'Polygon', coordinates: [data.fillPolygon] } },
              { type: 'Feature', properties: { kind: 'max', color }, geometry: { type: 'Polygon', coordinates: [data.maxPolygon] } },
            ],
          }
        : { type: 'FeatureCollection', features: [] }; // no home location configured
    map.getSource(COVERAGE_SOURCE_ID)?.setData(coverageGeoJSON);
  } catch {
    // Offline/unreachable -- leave whatever was last shown rather than flapping.
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
  ensureCoverageLayer();
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
// { lat, lon } | null -- null also covers "not configured" and "not
// authorized". Also read by map.on('load') below to pick the map's initial
// view -- see refreshHomeLocation.
let homeLocation = null;

// Also drives the map's initial center (map.on('load') below): home is
// either a manual override (Settings -> Server) or auto-detected from
// readsb's own receiver.json at startup (server/src/home.js's effective-home
// resolution) -- never a hardcoded coordinate here or anywhere else in this
// file.
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
  // Awaited before anything below can classify a single aircraft --
  // classifyIconKind() still resolves without it (falls through to the
  // ADS-B category fallback / 'unknown'), but every real type-table hit
  // would be missed for whichever aircraft happen to arrive in the gap.
  await loadIconTypes();
  const initialSettings = getSettings();
  setShorterTrails(initialSettings.shorterTrails);
  applyIconSize(initialSettings.aircraftIconSize);
  if (initialSettings.mapTheme === 'auto') await refreshDaylight();
  await switchBasemap(initialSettings.basemapMode, resolveMapTheme(initialSettings.mapTheme));
  // Awaited (and done *before* the pendingMessages flush below) so a
  // configured home location wins the initial view over the old fallback
  // -- whichever aircraft happened to be first in the very first snapshot,
  // essentially arbitrary. Falls through to that fallback unchanged when no
  // home is configured (or the browser isn't authorized to see it -- see
  // refreshHomeLocation's own comment).
  await refreshHomeLocation();
  if (homeLocation && !hasCentered) {
    map.jumpTo({ center: [homeLocation.lon, homeLocation.lat], zoom: INITIAL_ZOOM });
    hasCentered = true;
  }
  mapReady = true;
  for (const snapshot of pendingMessages.splice(0)) {
    handleSnapshot(snapshot);
  }
  refreshTrailForSettings();
  refreshCoverage();
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

setInterval(() => {
  if (getSettings().showCoverage) refreshCoverage();
}, COVERAGE_REFRESH_INTERVAL_MS);

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
  const { showCoverage, coverageBand } = getSettings();
  if (showCoverage !== lastRequestedShowCoverage || coverageBand !== lastRequestedCoverageBand) {
    refreshCoverage();
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
      // And for size -- dragging the icon-size slider should rescale every
      // marker immediately, each still respecting its own per-kind
      // multiplier (aircraft-icon-live.js), not just resetting the
      // :root-level fallback applyIconSize() already updated above.
      refreshMarkerSize(state.marker.getElement());
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
    activePopupHex = null;
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

// A labeled chip, same markup aircraft-panel.js's cluster rows already use
// (.mlpr-detail-chip/-chip b) so the popup reads as the same visual
// language as the full details panel it opens into, not a second one.
function popupChip(label, value) {
  return `<span class="mlpr-detail-chip"><b>${escapeHtml(label)}</b> ${value}</span>`;
}

function formatAircraftInfo(aircraft) {
  const { units } = getSettings();
  const callsign = escapeHtml(aircraft.flight || aircraft.hex);

  const chips = [];
  if (aircraft.typeCode) chips.push(popupChip(t('type'), escapeHtml(aircraft.typeCode)));
  if (aircraft.onGround) {
    // A standalone badge, not a labeled chip -- "on ground" isn't a value
    // for some other field, it's its own flag, same "flag" treatment
    // aircraft-panel.js's boolean tiles (military/alert/...) already get.
    chips.push(`<span class="mlpr-popup-badge">${escapeHtml(t('onGround'))}</span>`);
  } else {
    const altitude = formatAltitude(aircraft.altBaro, units);
    if (altitude) chips.push(popupChip(t('altitude'), altitude));
  }
  const speed = formatSpeed(aircraft.gs, units);
  if (speed) chips.push(popupChip(t('speed'), speed));

  const chipsHtml = chips.length ? `<div class="mlpr-popup-chips">${chips.join('')}</div>` : '';
  return `<div class="mlpr-popup-callsign">${callsign}</div>${chipsHtml}`;
}

function showInfoPopup(hex) {
  const state = aircraftState.get(hex);
  if (!state || !state.lastLngLat || !state.lastAircraft) return;

  const html =
    `<div class="mlpr-popup">${formatAircraftInfo(state.lastAircraft)}` +
    `<button type="button" id="mlpr-more-details">${t('showMoreDetails')}</button></div>`;

  // Same aircraft's popup is already open -- refresh position/content on the
  // *existing* instance instead of remove()-ing and creating a new one, so
  // applyAircraftUpdate's once-per-tick call for the selected aircraft (so
  // roughly once a second for active traffic) doesn't tear down and rebuild
  // the whole popup every time; only a genuinely new popup (a different
  // aircraft selected, or none open yet) needs that.
  if (activePopup && activePopupHex === hex) {
    activePopup.setLngLat(state.lastLngLat).setHTML(html);
    return;
  }

  activePopup?.remove();
  // Default offset is 0, so the popup's tip sits exactly on the aircraft's
  // coordinate -- since the marker (.mlpr-plane) is centered on that same
  // point, the box would end up covering half the icon. A flat pixel offset
  // pushes it clear of the marker on whichever side MapLibre auto-picks,
  // reading as "floating just above the plane". Derived from the
  // user-adjustable icon size (not a fixed constant) so it still clears the
  // marker at any size setting.
  const popupOffset = Math.round(getSettings().aircraftIconSize / 2) + 7;
  // focusAfterOpen: false -- MapLibre's Popup defaults this to true, and
  // its effect (_focusFirstElement()) isn't only wired to .addTo() the way
  // an earlier version of this comment assumed: setHTML()/setDOMContent()
  // call it too, on *every* call, addTo() or not. That means the "reuse
  // the existing instance" branch above -- added specifically to stop
  // .addTo() from re-stealing focus every tick -- was still calling
  // setHTML() every tick, which kept stealing it anyway via that second,
  // unguarded path. Reported again 2026-08-01 (still closing an open
  // <select> anywhere on the page -- by then also the new language
  // picker in Settings -- on every position update), traced by reading
  // maplibre-gl's actual Popup source rather than re-guessing the already
  // -documented-but-incomplete theory. This popup was never the app's
  // real keyboard-accessible surface anyway -- panels.js's own trapFocus
  // handles that properly for the full details panel "Show more details"
  // opens into -- so disabling MapLibre's focus grab entirely here, for
  // both the initial open and every refresh, is correct, not just a
  // workaround.
  activePopup = new maplibregl.Popup({
    closeButton: true, closeOnClick: false, offset: popupOffset, focusAfterOpen: false,
  })
    .setLngLat(state.lastLngLat)
    .setHTML(html)
    .addTo(map);
  activePopupHex = hex;
}

// A persistent, achromatic glow (.mlpr-plane-glow, styled in style.css) on
// whichever marker is currently selected -- deliberately not a color, since
// color on the icon itself is reserved for the active plane-color mode
// (signal loss/altitude/speed, see colorForAircraft below) and would either
// clash with or be mistaken for it. Markers persist across updates (see
// applyAircraftUpdate), so the class sticks until explicitly moved/cleared
// here -- no need to reapply every poll tick.
function setSelectionHighlight(hex) {
  if (selectedHex && selectedHex !== hex) {
    aircraftState.get(selectedHex)?.marker?.getElement().classList.remove('mlpr-plane-selected');
  }
  if (hex) {
    aircraftState.get(hex)?.marker?.getElement().classList.add('mlpr-plane-selected');
  }
}

async function selectAircraft(hex) {
  setSelectionHighlight(hex);
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

// List row hover -> highlight the matching marker. Same .mlpr-plane-hover
// class a direct marker hover uses (see applyAircraftUpdate), just applied
// from the other direction -- one global handler is enough since there's
// exactly one map, unlike selection/inspection which need per-aircraft
// bookkeeping.
setHoverRequestHandler((hex) => {
  if (lastHoverRequestHex) {
    aircraftState.get(lastHoverRequestHex)?.marker?.getElement().classList.remove('mlpr-plane-hover');
  }
  lastHoverRequestHex = hex;
  if (hex) {
    aircraftState.get(hex)?.marker?.getElement().classList.add('mlpr-plane-hover');
  }
});

function deselectAircraft() {
  setSelectionHighlight(null);
  selectedHex = null;
  setSelectedHex(null);
  renderTrail();
  activePopup?.remove();
  activePopup = null;
  activePopupHex = null;
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

// Mode-S-only contacts (no ADS-B position, and this receiver has no way to
// MLAT one) still carry real data -- callsign, altitude, squawk -- and
// tar1090/Virtual Radar Server both list them; MLPR used to silently drop
// them at this exact point (an early return here, before noteAircraft was
// ever reached), which meant they never appeared in the List or counted
// towards any total. Reported live: "why does tar1090 show more aircraft
// than MLPR's list" (2026-07-28). Fixed by splitting this function's two
// concerns -- "track this aircraft's data" (noteAircraft, always) and
// "place/update a map marker" (only when there's a position to place it
// at) -- which is also just a more honest description of what each half
// actually does. list.js flags a position-less row instead of showing it
// identically to a positioned one -- see list.js's NO_POSITION_ICON.
function applyAircraftUpdate(aircraft) {
  const now = Date.now();
  let state = aircraftState.get(aircraft.hex);

  if (!state) {
    state = { marker: null, lastUpdateAt: now, lastLngLat: null, goneAt: null };
    aircraftState.set(aircraft.hex, state);
  }

  const wasGone = state.goneAt !== null;
  state.lastUpdateAt = now;
  state.lastAircraft = aircraft;
  state.goneAt = null;

  noteAircraft(aircraft.hex, aircraft);

  if (typeof aircraft.lat !== 'number' || typeof aircraft.lon !== 'number') {
    // No plottable position right now -- still tracked (noteAircraft above
    // already made it visible to the List/Stats/etc.), just nothing to put
    // on the map. If this aircraft previously had a marker (a position
    // that stopped being reported mid-flight, rare but possible), leave
    // that marker exactly where it last was rather than snapping it away
    // or deleting it -- the regular fade/forget timers below retire it on
    // their own schedule if a real position never comes back.
    return;
  }

  const lngLat = [aircraft.lon, aircraft.lat];

  if (!state.marker) {
    state.marker = new maplibregl.Marker({ element: createPlaneElement(aircraft) }).setLngLat(lngLat).addTo(map);
    const el = state.marker.getElement();
    el.addEventListener('click', (event) => {
      event.stopPropagation();
      selectAircraft(aircraft.hex);
    });
    // Map -> list direction of the hover cross-highlight: broadcasts via
    // radar-state so list.js can highlight the matching row. The reverse
    // direction (list row hover -> highlight this marker) is handled once,
    // globally, by the setHoverRequestHandler registration below -- not
    // per-marker here.
    el.addEventListener('mouseenter', () => {
      el.classList.add('mlpr-plane-hover');
      setHoveredHex(aircraft.hex);
    });
    el.addEventListener('mouseleave', () => {
      el.classList.remove('mlpr-plane-hover');
      setHoveredHex(null);
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
  state.lastLngLat = lngLat;

  let trailChanged = false;
  const { trailMode } = getSettings();
  if (trailMode === 'all' || aircraft.hex === selectedHex) {
    recordPosition(aircraft.hex, lngLat, aircraft.onGround ? 0 : aircraft.altBaro, now, wasGone, aircraft.sourceType);
    trailChanged = true;
  }

  if (aircraft.hex === selectedHex) {
    showInfoPopup(aircraft.hex);
  }

  if (!hasCentered) {
    // Fallback for when no home location is configured (or the map.on('load')
    // handler's own home-based centering above didn't apply) -- lands on
    // whichever aircraft happens to be first, which is the best available
    // reference point with no home location to go on.
    map.jumpTo({ center: lngLat, zoom: INITIAL_ZOOM });
    hasCentered = true;
  }

  return trailChanged;
}

// applyAircraftUpdate() only *records* a trail point per aircraft (cheap);
// renderTrail() re-runs the MLAT filter/smoothing pass and rebuilds the
// entire shared GeoJSON source across every tracked aircraft (in
// trailMode: 'all', not just the one that changed) -- calling it once per
// aircraft in a batch meant a 20-aircraft delta rebuilt the whole trail
// source 20 times instead of once. Batched here the same way
// notifyAircraftChanged() already is for the same reason (see
// radar-state.js's comment on noteAircraft).
function handleSnapshot(snapshot) {
  if (snapshot.type === 'full') {
    resetAll();
    let trailChanged = false;
    for (const aircraft of snapshot.aircraft) {
      if (applyAircraftUpdate(aircraft)) trailChanged = true;
    }
    if (trailChanged) renderTrail();
    notifyAircraftChanged();
  } else if (snapshot.type === 'delta') {
    let trailChanged = false;
    for (const aircraft of snapshot.updated) {
      if (applyAircraftUpdate(aircraft)) trailChanged = true;
    }
    if (trailChanged) renderTrail();
    notifyAircraftChanged();
  } else if (snapshot.type === 'stats') {
    noteLiveStats({
      aircraftCount: snapshot.aircraftCount,
      messagesPerSec: snapshot.messagesPerSec,
      maxRangeKm: snapshot.maxRangeKm,
      maxRangeLastHourKm: snapshot.maxRangeLastHourKm,
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
