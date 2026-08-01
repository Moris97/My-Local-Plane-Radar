// Full-screen map editor for a watch-list entry's optional trigger area
// (server/src/notifications/watchlist.js's `area`).
//
// Only the circle shape is implemented; the rectangle and free-shape
// buttons are rendered but disabled, deliberately visible so the intended
// final shape of this UI is obvious rather than looking like the feature
// only ever supported circles. Adding them later means a new
// buildShape()/handles pair here plus a `kind` in watchlist.js's
// validateArea -- the surrounding editor chrome does not need to change.
//
// The area's centre is an arbitrary point, NOT the receiver's home: the
// whole point is watching a specific piece of sky (an airfield, an approach
// path) that may be well away from the antenna. Home is only used, when
// available, as the map's opening view so the editor doesn't start over the
// Atlantic.
import { t } from './i18n.js';
import { getSettings } from './settings-state.js';
import { getMapView } from './radar-state.js';
import { styleForSecondaryMap, addOfflineLayers } from './basemap.js';
import { circleRing, rectangleRing, rectangleEdges, distanceKm, destinationPoint } from './geo.js';
import { kmToDisplayDistance, displayDistanceToKm, distanceUnitLabel } from './units.js';

const SOURCE_ID = 'mlpr-area';
const FILL_LAYER_ID = 'mlpr-area-fill';
const OUTLINE_LAYER_ID = 'mlpr-area-outline';

// Sizes a freshly-created shape starts at, before any dragging. Always in
// km regardless of the user's display units (which only affect the
// readouts) -- km is the canonical stored unit everywhere.
const DEFAULT_RADIUS_KM = 50;
const DEFAULT_WIDTH_KM = 80;
const DEFAULT_HEIGHT_KM = 60;
// Below ~100 m a shape is smaller than the pin drawn on top of it, and
// sizes this large are nonsense for a single receiver -- these only exist
// to keep the drag interaction from producing a degenerate shape, not as a
// judgement about what's a "sensible" area.
const MIN_SIZE_KM = 0.1;
const MAX_SIZE_KM = 500;
// The bearing the circle's resize handle sits at. 90 = due east, so the
// handle appears to the right of the pin, where a right-handed user's drag
// naturally goes. The rectangle's two handles sit east (width) and north
// (height) for the same reason plus the obvious axis mapping.
const HANDLE_BEARING_DEG = 90;

const EDITOR_ZOOM = 9;

function clampSize(km) {
  return Math.min(MAX_SIZE_KM, Math.max(MIN_SIZE_KM, km));
}

function emptyCollection() {
  return { type: 'FeatureCollection', features: [] };
}

// One place that knows how each shape turns into a drawable ring; the two
// map layers never care which shape they're rendering.
function shapeRing(area) {
  if (area.kind === 'circle') return circleRing(area.lat, area.lon, area.radiusKm);
  if (area.kind === 'rectangle') return rectangleRing(area.lat, area.lon, area.widthKm, area.heightKm);
  return null;
}

function shapeCollection(area) {
  const ring = area ? shapeRing(area) : null;
  if (!ring) return emptyCollection();
  return {
    type: 'FeatureCollection',
    features: [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } }],
  };
}

function centreMarkerElement() {
  const el = document.createElement('div');
  el.className = 'mlpr-area-pin';
  el.innerHTML = `
    <svg viewBox="0 0 24 32" width="28" height="36" aria-hidden="true">
      <path d="M12 0a12 12 0 0 0-12 12c0 8.4 12 20 12 20s12-11.6 12-20A12 12 0 0 0 12 0z"/>
      <circle cx="12" cy="12" r="4.5"/>
    </svg>`;
  return el;
}

// The circumference grab handle and the radius readout live in one element
// so the number sits right next to the thing you're dragging (rather than
// in the toolbar, where it would be nowhere near the circle's edge). The
// <input> stops pointerdown from reaching MapLibre's drag handler, so
// clicking into the field to type doesn't also start dragging the handle.
function handleMarkerElement(units) {
  const el = document.createElement('div');
  el.className = 'mlpr-area-handle';
  el.innerHTML = `
    <span class="mlpr-area-handle-dot" aria-hidden="true"></span>
    <span class="mlpr-area-readout">
      <input type="number" class="mlpr-area-radius-input" min="0" step="any" aria-label="${t('areaRadius')}">
      <span class="mlpr-area-radius-unit">${distanceUnitLabel(units)}</span>
    </span>`;
  const input = el.querySelector('.mlpr-area-radius-input');
  for (const type of ['pointerdown', 'mousedown', 'touchstart', 'click', 'dblclick']) {
    input.addEventListener(type, (event) => event.stopPropagation());
  }
  return el;
}

// Resolves to:
//   an area object -- saved
//   null           -- explicitly cleared
//   undefined      -- cancelled, caller should keep whatever it had
// The three-way result is why this returns a promise rather than taking a
// callback: "cancelled" and "cleared" are genuinely different answers and
// the watch-list form has to tell them apart.
export function openAreaEditor(initialArea = null) {
  return new Promise((resolve) => {
    const overlay = document.getElementById('area-editor');
    const { units, basemapMode, mapTheme } = getSettings();

    // `area` is the single source of truth for the shape being edited;
    // every marker/layer below is redrawn from it rather than any of them
    // holding position state of their own.
    let area = initialArea ? { ...initialArea } : null;
    let map = null;
    let centreMarker = null;
    // One entry per resize handle: the circle has a single radius handle,
    // the rectangle has one per axis. Each knows how to read its own value
    // out of `area` and how to put itself back on the shape's edge, so the
    // shared drag/typing plumbing below doesn't branch on shape at all.
    let handles = [];
    // Which shape the toolbar is currently set to build. Kept separate from
    // area?.kind because it also has to survive "cleared, nothing drawn yet".
    let shapeKind = initialArea?.kind ?? 'circle';

    overlay.classList.remove('hidden');
    overlay.setAttribute('aria-hidden', 'false');
    overlay.innerHTML = `
      <div class="mlpr-area-toolbar">
        <!-- The free-shape (polygon) button is deliberately absent, not
             disabled: a greyed-out control still reads as a promise, and
             this one has no implementation behind it yet. Re-add it here
             alongside the polygon work (see TODO.md) -- its translation
             keys (areaPolygonLabel) are already in i18n.js. -->
        <div class="mlpr-area-shapes">
          <button type="button" class="mlpr-range-btn" data-shape="circle">${t('areaCircleLabel')}</button>
          <button type="button" class="mlpr-range-btn" data-shape="rectangle">${t('areaRectangleLabel')}</button>
        </div>
        <div class="mlpr-area-actions">
          <button type="button" id="mlpr-area-clear">${t('clearArea')}</button>
          <button type="button" id="mlpr-area-cancel">${t('areaCancel')}</button>
          <button type="button" id="mlpr-area-save" class="mlpr-area-save">${t('areaSave')}</button>
        </div>
      </div>
      <p class="mlpr-area-hint" id="mlpr-area-hint">${t('areaEditorHint')}</p>
      <div class="mlpr-area-map" id="mlpr-area-map"></div>
    `;

    const hintEl = overlay.querySelector('#mlpr-area-hint');

    // Per-shape handle definitions: which field each handle edits, where it
    // sits on the shape, and how a drag position turns into a value. Adding
    // a shape means adding an entry here -- the marker wiring below is
    // shape-agnostic.
    const HANDLE_SPECS = {
      circle: [
        {
          field: 'radiusKm',
          // Bearing it's pinned to; the drag itself may go anywhere, the
          // handle snaps back here on dragend.
          bearing: HANDLE_BEARING_DEG,
          distance: (a) => a.radiusKm,
          // A circle has no orientation, so only how *far* the handle was
          // dragged matters, not in which direction.
          valueFromDrag: (a, lat, lon) => distanceKm(a.lat, a.lon, lat, lon),
        },
      ],
      rectangle: [
        {
          field: 'widthKm',
          bearing: 90, // east edge
          distance: (a) => a.widthKm / 2,
          // The handle sits at the edge, i.e. half the full width from the
          // centre -- so dragging it out by X grows the box by 2X, keeping
          // it centred rather than stretching one side.
          valueFromDrag: (a, lat, lon) => distanceKm(a.lat, a.lon, a.lat, lon) * 2,
        },
        {
          field: 'heightKm',
          bearing: 0, // north edge
          distance: (a) => a.heightKm / 2,
          valueFromDrag: (a, lat, lon) => distanceKm(a.lat, a.lon, lat, a.lon) * 2,
        },
      ],
    };

    function syncHandleInputs() {
      if (!area) return;
      for (const handle of handles) {
        // Two decimals is enough to be honest about a dragged value without
        // showing the full float; the stored value keeps full precision.
        const display = kmToDisplayDistance(area[handle.spec.field], units);
        handle.input.value = String(Math.round(display * 100) / 100);
      }
    }

    function redrawShape() {
      map?.getSource(SOURCE_ID)?.setData(shapeCollection(area));
      hintEl.style.display = area ? 'none' : '';
    }

    function positionHandles() {
      if (!area) return;
      for (const handle of handles) {
        const point = destinationPoint(area.lat, area.lon, handle.spec.bearing, handle.spec.distance(area));
        handle.marker.setLngLat([point.lon, point.lat]);
      }
    }

    function removeMarkers() {
      centreMarker?.remove();
      centreMarker = null;
      for (const handle of handles) handle.marker.remove();
      handles = [];
    }

    // Torn down and rebuilt wholesale rather than patched, since switching
    // shape changes how many handles there are and what each one edits.
    function rebuildMarkers() {
      removeMarkers();
      if (!area || !map) return;

      centreMarker = new maplibregl.Marker({ element: centreMarkerElement(), draggable: true, anchor: 'bottom' })
        .setLngLat([area.lon, area.lat])
        .addTo(map);
      centreMarker.on('drag', () => {
        // Dragging the pin moves the whole shape: the centre follows the
        // pointer and the size fields are untouched, so the handles are
        // just recomputed from the new centre rather than dragged along.
        const { lng, lat } = centreMarker.getLngLat();
        area.lat = lat;
        area.lon = lng;
        redrawShape();
        positionHandles();
      });

      for (const spec of HANDLE_SPECS[area.kind] ?? []) {
        const element = handleMarkerElement(units);
        const input = element.querySelector('.mlpr-area-radius-input');
        const marker = new maplibregl.Marker({ element, draggable: true })
          .setLngLat([area.lon, area.lat])
          .addTo(map);

        input.addEventListener('input', () => {
          const typed = Number(input.value);
          if (!Number.isFinite(typed) || typed <= 0) return;
          area[spec.field] = clampSize(displayDistanceToKm(typed, units));
          redrawShape();
          positionHandles();
        });

        marker.on('drag', () => {
          const { lng, lat } = marker.getLngLat();
          area[spec.field] = clampSize(spec.valueFromDrag(area, lat, lng));
          redrawShape();
          syncHandleInputs();
        });
        marker.on('dragend', positionHandles);

        handles.push({ spec, marker, input });
      }

      positionHandles();
      syncHandleInputs();
    }

    function close(result) {
      // Order matters: tear the map down before hiding the overlay, so
      // MapLibre isn't left holding a WebGL context for a display:none
      // element that may never be shown again.
      removeMarkers();
      map?.remove();
      map = null;
      overlay.classList.add('hidden');
      overlay.setAttribute('aria-hidden', 'true');
      overlay.innerHTML = '';
      document.removeEventListener('keydown', onKeydown);
      resolve(result);
    }

    function onKeydown(event) {
      if (event.key === 'Escape') close(undefined);
    }
    document.addEventListener('keydown', onKeydown);

    overlay.querySelector('#mlpr-area-cancel').addEventListener('click', () => close(undefined));
    overlay.querySelector('#mlpr-area-save').addEventListener('click', () => close(area));
    overlay.querySelector('#mlpr-area-clear').addEventListener('click', () => close(null));

    const shapeButtons = [...overlay.querySelectorAll('.mlpr-area-shapes button[data-shape]')];

    function syncShapeButtons() {
      for (const button of shapeButtons) {
        button.classList.toggle('active', button.dataset.shape === shapeKind);
      }
      // The click-the-map prompt only applies to the circle; a rectangle is
      // placed the moment its button is pressed, so leaving the hint up
      // would be telling the user to do something that does nothing.
      hintEl.style.display = !area && shapeKind === 'circle' ? '' : 'none';
    }

    for (const button of shapeButtons) {
      button.addEventListener('click', () => {
        const kind = button.dataset.shape;
        if (kind === shapeKind) return;
        shapeKind = kind;

        if (kind === 'rectangle') {
          // Appears immediately, centred on whatever the map is showing --
          // there's no "click to place" step for a rectangle (explicit
          // spec), so it has to land somewhere sensible on its own.
          const centre = map.getCenter();
          area = {
            kind: 'rectangle',
            lat: centre.lat,
            lon: centre.lng,
            widthKm: DEFAULT_WIDTH_KM,
            heightKm: DEFAULT_HEIGHT_KM,
          };
        } else {
          // Switching to the circle drops back to click-to-place rather
          // than silently converting the rectangle: the two have no
          // meaningful common size, and guessing one would quietly change
          // an area the user had already tuned.
          area = null;
        }

        rebuildMarkers();
        redrawShape();
        syncShapeButtons();
      });
    }

    const { effective, style } = styleForSecondaryMap(basemapMode, mapTheme === 'light' ? 'light' : 'dark');

    try {
      map = new maplibregl.Map({
        container: overlay.querySelector('#mlpr-area-map'),
        style,
        center: [0, 0],
        zoom: 2,
        attributionControl: false,
      });
    } catch {
      // MapLibre's constructor throws synchronously when a WebGL context
      // can't be created. Without this the whole promise would reject and
      // the caller's `await` would blow up with the overlay still on
      // screen; closing cleanly instead means a browser that can't run the
      // map simply leaves the entry's area unchanged, the same as
      // cancelling. Not a hypothetical: this is exactly how the map fails
      // in a headless/software-rendering environment.
      close(undefined);
      return;
    }
    map.dragRotate.disable();
    map.touchZoomRotate.disableRotation();

    map.on('style.load', () => {
      if (effective === 'offline') addOfflineLayers(map, mapTheme === 'light' ? 'light' : 'dark');

      map.addSource(SOURCE_ID, { type: 'geojson', data: shapeCollection(area) });
      map.addLayer({
        id: FILL_LAYER_ID,
        type: 'fill',
        source: SOURCE_ID,
        paint: { 'fill-color': '#3ddc84', 'fill-opacity': 0.18 },
      });
      map.addLayer({
        id: OUTLINE_LAYER_ID,
        type: 'line',
        source: SOURCE_ID,
        paint: { 'line-color': '#3ddc84', 'line-width': 2 },
      });

      rebuildMarkers();
      redrawShape();
      syncShapeButtons();
    });

    map.on('load', async () => {
      // Opening view, in order of preference:
      //   1. the existing area, when editing one -- you want to see it;
      //   2. whatever the main map is currently showing (radar-state's
      //      mapView) -- if the user has panned to an approach path and
      //      then clicks "set trigger area", opening anywhere else means
      //      immediately re-navigating to where they already were;
      //   3. the receiver's location, if known and readable (same
      //      /api/settings access control as the home marker);
      //   4. the world view, so at least nothing is broken.
      // Never a hardcoded coordinate.
      if (area) {
        map.jumpTo({ center: [area.lon, area.lat], zoom: EDITOR_ZOOM });
        return;
      }

      const mainView = getMapView();
      if (mainView) {
        map.jumpTo({ center: [mainView.lon, mainView.lat], zoom: mainView.zoom });
        return;
      }

      try {
        const response = await fetch('/api/settings');
        if (!response.ok) return;
        const data = await response.json();
        if (typeof data.homeLat === 'number' && typeof data.homeLon === 'number') {
          map.jumpTo({ center: [data.homeLon, data.homeLat], zoom: EDITOR_ZOOM });
        }
      } catch {
        // Offline/unauthorized -- the world view is a usable, if clumsy,
        // starting point; the user can pan to wherever they meant.
      }
    });

    // Click-to-place is the circle's way in only -- a rectangle is created
    // the moment its toolbar button is pressed. Either way the map click
    // does nothing once a shape exists (moving it is the pin's own drag),
    // so an accidental click while adjusting can't teleport the shape.
    map.on('click', (event) => {
      if (area || shapeKind !== 'circle') return;
      area = { kind: 'circle', lat: event.lngLat.lat, lon: event.lngLat.lng, radiusKm: DEFAULT_RADIUS_KM };
      rebuildMarkers();
      redrawShape();
      syncShapeButtons();
    });
  });
}
