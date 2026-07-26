import { createPlaneElement, setPlaneHeading, setPlaneColor } from './aircraft-icon.js';

const DEFAULT_CENTER = [0, 0];
const DEFAULT_ZOOM = 2;

const FADE_START_MS = 3000;
const DISAPPEAR_MS = 10000;
const FORGET_MS = 5 * 60 * 1000;
const TICK_INTERVAL_MS = 300;
const MAX_GAP_SEGMENTS = 200;

const FRESH_COLOR = [61, 220, 132]; // #3ddc84
const STALE_COLOR = [224, 49, 49]; // #e03131

const GAP_SOURCE_ID = 'mlpr-gap-segments';

const map = new maplibregl.Map({
  container: 'map',
  style: {
    version: 8,
    sources: {},
    layers: [
      {
        id: 'background',
        type: 'background',
        paint: { 'background-color': '#05070a' },
      },
    ],
  },
  center: DEFAULT_CENTER,
  zoom: DEFAULT_ZOOM,
  attributionControl: false,
});

const aircraftState = new Map();
let gapFeatures = [];
let hasCentered = false;
let mapReady = false;
const pendingMessages = [];

map.on('load', () => {
  map.addSource(GAP_SOURCE_ID, {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  });
  map.addLayer({
    id: GAP_SOURCE_ID,
    type: 'line',
    source: GAP_SOURCE_ID,
    paint: {
      'line-color': '#888a8f',
      'line-width': 2,
      'line-dasharray': [2, 2],
    },
  });

  mapReady = true;
  for (const snapshot of pendingMessages.splice(0)) {
    handleSnapshot(snapshot);
  }
});

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function colorForElapsed(elapsedMs) {
  if (elapsedMs <= FADE_START_MS) {
    return `rgb(${FRESH_COLOR.join(',')})`;
  }
  const t = Math.min(1, (elapsedMs - FADE_START_MS) / (DISAPPEAR_MS - FADE_START_MS));
  const r = Math.round(lerp(FRESH_COLOR[0], STALE_COLOR[0], t));
  const g = Math.round(lerp(FRESH_COLOR[1], STALE_COLOR[1], t));
  const b = Math.round(lerp(FRESH_COLOR[2], STALE_COLOR[2], t));
  return `rgb(${r},${g},${b})`;
}

function addGapSegment(from, to) {
  gapFeatures.push({
    type: 'Feature',
    geometry: { type: 'LineString', coordinates: [from, to] },
    properties: {},
  });
  if (gapFeatures.length > MAX_GAP_SEGMENTS) {
    gapFeatures = gapFeatures.slice(-MAX_GAP_SEGMENTS);
  }
  map.getSource(GAP_SOURCE_ID)?.setData({ type: 'FeatureCollection', features: gapFeatures });
}

function resetAll() {
  for (const state of aircraftState.values()) {
    state.marker?.remove();
  }
  aircraftState.clear();
  gapFeatures = [];
  map.getSource(GAP_SOURCE_ID)?.setData({ type: 'FeatureCollection', features: [] });
  hasCentered = false;
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

  if (state.goneAt !== null && state.lastLngLat) {
    addGapSegment(state.lastLngLat, lngLat);
  }

  if (!state.marker) {
    state.marker = new maplibregl.Marker({ element: createPlaneElement() }).setLngLat(lngLat).addTo(map);
  } else {
    state.marker.setLngLat(lngLat);
  }

  setPlaneHeading(state.marker.getElement(), aircraft.track);
  setPlaneColor(state.marker.getElement(), colorForElapsed(0));

  state.lastUpdateAt = now;
  state.lastLngLat = lngLat;
  state.goneAt = null;

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
  }
}

setInterval(() => {
  const now = Date.now();

  for (const [hex, state] of aircraftState) {
    if (state.goneAt !== null) {
      if (now - state.goneAt > FORGET_MS) {
        aircraftState.delete(hex);
      }
      continue;
    }

    const elapsed = now - state.lastUpdateAt;

    if (elapsed >= DISAPPEAR_MS) {
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
