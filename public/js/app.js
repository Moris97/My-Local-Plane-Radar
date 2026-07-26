import { createPlaneElement, setPlaneHeading } from './aircraft-icon.js';

const DEFAULT_CENTER = [0, 0];
const DEFAULT_ZOOM = 2;

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

const markers = new Map();
let hasCentered = false;

function updateAircraft(list) {
  const seenHex = new Set();

  for (const aircraft of list) {
    if (typeof aircraft.lat !== 'number' || typeof aircraft.lon !== 'number') {
      continue;
    }

    seenHex.add(aircraft.hex);

    let marker = markers.get(aircraft.hex);
    if (!marker) {
      marker = new maplibregl.Marker({ element: createPlaneElement() })
        .setLngLat([aircraft.lon, aircraft.lat])
        .addTo(map);
      markers.set(aircraft.hex, marker);
    } else {
      marker.setLngLat([aircraft.lon, aircraft.lat]);
    }

    setPlaneHeading(marker.getElement(), aircraft.track);

    if (!hasCentered) {
      map.jumpTo({ center: [aircraft.lon, aircraft.lat], zoom: 9 });
      hasCentered = true;
    }
  }

  for (const [hex, marker] of markers) {
    if (!seenHex.has(hex)) {
      marker.remove();
      markers.delete(hex);
    }
  }
}

function connect() {
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${protocol}://${location.host}/ws`);

  ws.addEventListener('message', (event) => {
    const snapshot = JSON.parse(event.data);
    updateAircraft(snapshot.aircraft ?? []);
  });

  ws.addEventListener('close', () => {
    setTimeout(connect, 1000);
  });

  ws.addEventListener('error', () => ws.close());
}

connect();
