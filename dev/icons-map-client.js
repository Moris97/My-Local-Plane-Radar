import { getIconPath, getIconSizeMultiplier, ICON_SIZE_MULTIPLIERS, VIEW_BOX } from '/js/plane-icons.js';
import { classifyIconKind, loadIconTypes } from '/js/icon-classify.js';
import { ICON_SIZE_DEFAULT } from '/js/settings-state.js';

// Placeholder location only (CLAUDE.md: never hardcode a real receiver
// position) -- not tied to any real install, just a center to scatter demo
// markers around.
const CENTER = { lat: 50.0, lon: 20.0 };
const LAT_STEP = 0.16;
const LON_STEP = 0.32;

// One representative input per icon kind, each picked so it actually
// exercises a different link of the real classification chain (exact,
// prefix, the military override, an ADS-B category fallback, the typeCode
// 'TWR' special case, or genuinely nothing -> unknown) -- this is a live
// end-to-end check of icon-classify.js + data/icon-types.json, not just a
// gallery of shapes.
const DEMO_AIRCRAFT = [
  { expect: 'narrowbody', row: 0, col: 0, track: 0, typeCode: 'B738' },
  { expect: 'widebody2', row: 0, col: 1, track: 45, typeCode: 'B77W' },
  { expect: 'widebody3', row: 0, col: 2, track: 90, typeCode: 'MD11' },
  { expect: 'widebody4', row: 0, col: 3, track: 135, typeCode: 'A388' },
  { expect: 'light', row: 0, col: 4, track: 180, typeCode: 'C172' },
  { expect: 'bizjet', row: 1, col: 0, track: 225, typeCode: 'GLF5' },
  { expect: 'cargo_turboprop', row: 1, col: 1, track: 270, typeCode: 'C130' },
  { expect: 'cargo_jet', row: 1, col: 2, track: 315, typeCode: 'C17' },
  { expect: 'military_jet', row: 1, col: 3, track: 20, typeCode: 'F16' },
  { expect: 'special', row: 1, col: 4, track: 60, typeCode: 'A332', military: true },
  { expect: 'helicopter', row: 2, col: 0, track: 100, category: 'A7' },
  { expect: 'glider', row: 2, col: 1, track: 140, category: 'B1' },
  { expect: 'balloon', row: 2, col: 2, track: 180, category: 'B2' },
  { expect: 'drone', row: 2, col: 3, track: 220, category: 'B6' },
  { expect: 'ground_vehicle', row: 2, col: 4, track: 260, category: 'C1' },
  { expect: 'unknown', row: 3, col: 0, track: 300 },
  { expect: 'tower', row: 3, col: 1, track: 0, typeCode: 'TWR' },
];

function positionFor({ row, col }) {
  return [CENTER.lon + (col - 2) * LON_STEP, CENTER.lat + (1.5 - row) * LAT_STEP];
}

function markerElement(kind, aircraft, stage) {
  const wrapper = document.createElement('div');
  wrapper.className = 'mlpr-dev-plane';
  const size = Math.round(ICON_SIZE_DEFAULT * getIconSizeMultiplier(kind));
  wrapper.style.width = `${size}px`;
  wrapper.style.height = `${size}px`;
  const inputLabel = aircraft.typeCode ?? (aircraft.category ? `cat ${aircraft.category}` : '(no data)');
  const rotation = kind === 'tower' ? 0 : aircraft.track;
  wrapper.innerHTML = `
    <svg viewBox="${VIEW_BOX}" fill="none" style="transform: rotate(${rotation}deg)">
      <path d="${getIconPath(kind)}" fill="currentColor"/>
    </svg>
    <div class="mlpr-dev-plane-label">${kind}<span class="stage">${inputLabel}${aircraft.military ? ' · mil' : ''} · ${stage}</span></div>
  `;
  return wrapper;
}

async function main() {
  await loadIconTypes();

  const map = new maplibregl.Map({
    container: 'map',
    style: '/mapstyles/online-dark.json',
    center: [CENTER.lon, CENTER.lat],
    zoom: 7,
    attributionControl: false,
  });
  map.dragRotate.disable();
  map.touchZoomRotate.disableRotation();

  map.on('load', () => {
    const bounds = new maplibregl.LngLatBounds();
    for (const aircraft of DEMO_AIRCRAFT) {
      const { icon, stage } = classifyIconKind(aircraft);
      if (icon !== aircraft.expect) {
        console.warn(
          `icons-map dev tool: expected "${aircraft.expect}" but classifyIconKind returned "${icon}" (stage: ${stage}) for`,
          aircraft,
          '-- data/icon-types.json probably changed under this demo entry.',
        );
      }
      const lngLat = positionFor(aircraft);
      bounds.extend(lngLat);
      new maplibregl.Marker({ element: markerElement(icon, aircraft, stage) }).setLngLat(lngLat).addTo(map);
    }
    map.fitBounds(bounds, { padding: 80, duration: 0 });
  });

  console.log('Icon size multipliers in use:', ICON_SIZE_MULTIPLIERS);
}

main();
