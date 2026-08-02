// Full-screen map editor for a watch-list entry's optional trigger area
// (server/src/notifications/watchlist.js's `area`).
//
// Three shapes, each with its own way in and its own handles:
//   circle    -- click the map to place it, one handle sets the radius
//   rectangle -- appears at the map centre, one handle per axis
//   polygon   -- appears at the map centre as a hexagon; the handles ARE
//                the vertices, and the outline is edited by dragging,
//                adding (tap an edge) and removing (double-tap a vertex,
//                or its right-click menu) them
//
// The first two are defined by centre + size, so their handles are derived
// from the shape and snap back onto it after every drag. A polygon inverts
// that: the vertices are the shape and the centre trails them, existing
// only as the "move the whole thing" grab handle.
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
import {
  circleRing,
  rectangleRing,
  rectangleEdges,
  polygonRing,
  polygonCentroid,
  regularPolygonPoints,
  distanceKm,
  destinationPoint,
} from './geo.js';
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
// A fresh free-form area starts as a hexagon: enough sides to read as
// "drag these around" rather than a shape in its own right, few enough that
// the vertices aren't crowded at the default zoom.
const DEFAULT_POLYGON_SIDES = 6;
const DEFAULT_POLYGON_RADIUS_KM = 40;
// Must match watchlist.js's POLYGON_MIN_POINTS/POLYGON_MAX_POINTS -- the
// server rejects anything outside this, so the editor simply never lets you
// get there rather than letting Save fail.
const POLYGON_MIN_POINTS = 3;
const POLYGON_MAX_POINTS = 60;
// How close (in screen pixels) a click has to land to an edge to count as
// "on it" and insert a vertex there. Generous enough for a fingertip
// without swallowing clicks meant for the empty map.
const EDGE_HIT_TOLERANCE_PX = 14;
// Double-tap detection is done by hand rather than with the native
// `dblclick` event, because a draggable MapLibre marker cannot reliably
// produce one. From maplibre-gl's own Marker._onMove: as soon as the
// pointer moves past `clickTolerance` (3px by default) it sets
// `element.style.pointerEvents = 'none'` -- deliberately, to "suppress
// click event so that popups don't toggle on drag" -- and only restores it
// on mouseup. A few pixels of drift while double-clicking a small dot is
// the norm, so `click` (and therefore `dblclick`) simply never reaches the
// element. Reported as "double-click doesn't remove a vertex on PC",
// 2026-08-02; the original test missed it by dispatching a synthetic
// dblclick, which bypasses that whole mechanism.
//
// `pointerdown` always arrives (pointer-events is only suppressed *during*
// a drag, and is back to 'auto' before the next press), covers mouse and
// touch with one path, and doesn't care how far the pointer drifted.
//
// The window and slop are sized for a fingertip, not a mouse: reported
// 2026-08-02 as "double-tap doesn't remove a vertex, but only on a phone".
const DOUBLE_TAP_MS = 450;
const DOUBLE_TAP_PX = 32;
// How far the vertex has to actually travel during a press before that
// press counts as a real drag (and so disqualifies the *next* press from
// completing a double-tap). This cannot be left to MapLibre's own
// `dragstart`, which is the other half of the phone-only bug above: Marker
// starts dragging at 3px of movement (`clickTolerance`, defaulted from the
// map), and a finger practically never holds a 16px dot to within 3px, so
// on touch every single tap fired `dragstart` and marked itself as a drag.
// A mouse click usually doesn't move at all, which is exactly why this went
// unnoticed on desktop.
const TAP_DRIFT_PX = 12;
// Clear of the vertex dot's 16px width, so the right-click menu never sits
// over the spot the next press would land on -- see openVertexMenu.
const VERTEX_MENU_OFFSET_PX = 12;
// How long the map's own double-tap zoom stays muted after a vertex
// double-tap -- see suppressTapZoom. Comfortably past the touchend that
// completes the pair, short enough that the gesture is available again by
// the time a hand could reach for it.
const TAP_ZOOM_MUTE_MS = 500;
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
  if (area.kind === 'polygon') return polygonRing(area.points);
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

// A polygon vertex: just the grab dot, no readout. Unlike the circle's and
// rectangle's handles there is no single number to show -- a vertex is a
// position, and the shape's "size" is the whole outline.
//
// The dot MUST be a real child element, not a ::after on the 0x0 root, and
// this is not a style preference: a pseudo-element is painted but generates
// no hit-test target of its own, so with a 0x0 originating element
// `document.elementFromPoint()` over the dot returns null. Nothing can be
// clicked, and MapLibre's drag handler -- which gates on
// `element.contains(event.target)` -- never recognises the marker either,
// so the vertex can't even be dragged. Found 2026-08-02 while chasing "the
// double-click doesn't remove a vertex"; .mlpr-area-handle-dot had it right
// all along and this broke from that pattern.
function vertexMarkerElement() {
  const el = document.createElement('div');
  el.className = 'mlpr-area-vertex';
  const dot = document.createElement('span');
  dot.className = 'mlpr-area-vertex-dot';
  el.appendChild(dot);
  return el;
}

// Perpendicular distance from p to segment a-b, plus the closest point on
// it, all in screen pixels. Done in screen space rather than lat/lon
// because the question being asked is "did the user click near this line",
// which is inherently about what they see: at high latitudes a degree of
// longitude is a fraction of the on-screen distance a degree of latitude
// is, so a lat/lon distance would make edges harder to hit the further
// north you are.
function closestPointOnSegment(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  // Degenerate segment (two vertices dragged onto each other): the "closest
  // point" is just the vertex, and the projection below would divide by 0.
  const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq));
  const point = { x: a.x + t * dx, y: a.y + t * dy };
  return { point, distance: Math.hypot(p.x - point.x, p.y - point.y) };
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
    // Polygon only -- one per vertex, index-aligned with area.points.
    let vertexMarkers = [];
    let vertexMenuEl = null;
    // Hand-rolled double-tap state, shared across vertex markers because a
    // rebuild replaces every marker (and every index) -- see DOUBLE_TAP_MS.
    let lastTap = { index: -1, time: 0, x: 0, y: 0 };
    // Set only once a press has moved the vertex further than TAP_DRIFT_PX,
    // never merely because MapLibre decided a drag had begun.
    let draggedSinceLastTap = false;
    let dragOriginPoint = null;
    let tapZoomTimer = null;
    // Which shape the toolbar is currently set to build. Kept separate from
    // area?.kind because it also has to survive "cleared, nothing drawn yet".
    let shapeKind = initialArea?.kind ?? 'circle';
    let hintTimer = null;

    overlay.classList.remove('hidden');
    overlay.setAttribute('aria-hidden', 'false');
    // The dialog's accessible name. Set here rather than in index.html
    // because this overlay has no persistent title element to reference,
    // and it has to be translated like the rest of the UI.
    overlay.setAttribute('aria-label', t('areaEditorTitle'));
    overlay.innerHTML = `
      <div class="mlpr-area-toolbar">
        <div class="mlpr-area-shapes">
          <button type="button" class="mlpr-range-btn" data-shape="circle">${t('areaCircleLabel')}</button>
          <button type="button" class="mlpr-range-btn" data-shape="rectangle">${t('areaRectangleLabel')}</button>
          <button type="button" class="mlpr-range-btn" data-shape="polygon">${t('areaPolygonLabel')}</button>
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

    // One hint strip, two jobs: the standing instruction for the current
    // shape, and transient feedback for something that just happened (a
    // refused vertex removal). A transient message reverts to the standing
    // one rather than leaving the strip blank, so the instruction is never
    // lost after a warning.
    function showHint(text, transient = false) {
      if (hintTimer) clearTimeout(hintTimer);
      hintEl.textContent = text;
      hintEl.classList.toggle('mlpr-area-hint-warn', transient);
      hintEl.style.display = text ? '' : 'none';
      if (transient) {
        hintTimer = setTimeout(() => {
          hintTimer = null;
          refreshStandingHint();
        }, 2600);
      }
    }

    // What the strip says when nothing has just happened: how to start for
    // an empty circle, how to edit for a polygon, nothing at all otherwise
    // (a placed circle or rectangle is self-explanatory -- drag the pin or
    // an edge handle).
    function refreshStandingHint() {
      if (!area && shapeKind === 'circle') return showHint(t('areaEditorHint'));
      if (area?.kind === 'polygon') return showHint(t('areaPolygonHint'));
      return showHint('');
    }

    // A double-tap on a vertex bubbles to the map like any other touch, and
    // MapLibre's tap-zoom handler answers it by zooming in -- so removing a
    // vertex would move the whole map under the user's finger at the same
    // time. The `dblclick` listener on each vertex only blocks the *mouse*
    // half of this; the touch half is driven by touchstart/touchend on the
    // canvas container, which can't be stopped from bubbling without also
    // stopping MapLibre's Marker drag handler (it listens for the very same
    // bubbled events). Muting the zoom handler for the rest of the gesture
    // leaves dragging untouched.
    function suppressTapZoom() {
      if (!map?.doubleClickZoom) return;
      map.doubleClickZoom.disable();
      if (tapZoomTimer) clearTimeout(tapZoomTimer);
      tapZoomTimer = setTimeout(() => {
        tapZoomTimer = null;
        map?.doubleClickZoom?.enable();
      }, TAP_ZOOM_MUTE_MS);
    }

    function closeVertexMenu() {
      vertexMenuEl?.remove();
      vertexMenuEl = null;
    }

    // Right-click on a vertex. Deliberately a real menu rather than an
    // immediate delete: the right button removing something with no
    // confirmation would be a surprising amount of destruction for one
    // misclick.
    function openVertexMenu(x, y, index) {
      closeVertexMenu();
      vertexMenuEl = document.createElement('div');
      vertexMenuEl.className = 'mlpr-area-vertex-menu';
      // Offset off the pointer, not flush to it. Two reasons, and the
      // second is load-bearing: a menu whose first item sits directly under
      // the cursor is easy to trigger by accident, and -- since a
      // double-click with *either* button removes a vertex -- a menu
      // covering the click position would swallow the second press and
      // stop the right-button double-click from ever being detected.
      vertexMenuEl.style.left = `${x + VERTEX_MENU_OFFSET_PX}px`;
      vertexMenuEl.style.top = `${y + VERTEX_MENU_OFFSET_PX}px`;

      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = t('areaRemoveVertex');
      // Shown disabled rather than hidden, so the reason the action is
      // unavailable is visible instead of the menu just looking empty.
      button.disabled = area.points.length <= POLYGON_MIN_POINTS;
      button.addEventListener('click', () => {
        closeVertexMenu();
        removeVertex(index);
      });

      vertexMenuEl.appendChild(button);
      overlay.appendChild(vertexMenuEl);
    }

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
      // Hint visibility is refreshStandingHint's job, not this one's -- a
      // polygon keeps a standing instruction *while* it exists, so tying
      // the strip to "is there a shape" would hide it on every redraw.
      if (!hintTimer) refreshStandingHint();
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
      for (const marker of vertexMarkers) marker.remove();
      vertexMarkers = [];
      closeVertexMenu();
    }

    // Polygon only: one draggable dot per vertex. Unlike the circle's and
    // rectangle's handles -- which are *derived* from the centre and size,
    // and snap back onto the shape after every drag -- these ARE the shape.
    // Dragging one edits area.points directly and the centre follows them,
    // not the other way round.
    function addVertexMarkers() {
      area.points.forEach((point, index) => {
        const element = vertexMarkerElement();
        const marker = new maplibregl.Marker({ element, draggable: true })
          .setLngLat([point.lon, point.lat])
          .addTo(map);

        marker.on('drag', () => {
          const { lng, lat } = marker.getLngLat();
          // Measured in screen pixels against where the press started, so
          // "did they mean to move it" is judged the same way the user sees
          // it, at any zoom -- see TAP_DRIFT_PX.
          if (dragOriginPoint && !draggedSinceLastTap) {
            const now = map.project([lng, lat]);
            if (Math.hypot(now.x - dragOriginPoint.x, now.y - dragOriginPoint.y) >= TAP_DRIFT_PX) {
              draggedSinceLastTap = true;
            }
          }
          area.points[index] = { lat, lon: lng };
          syncPolygonCentre();
          redrawShape();
        });

        // Double-tap/double-click removes the vertex -- detected from
        // consecutive pointerdowns rather than the native dblclick, which a
        // draggable marker can't reliably deliver (see DOUBLE_TAP_MS).
        //
        // `event.button` is deliberately not checked: either button counts,
        // and so does a mixed pair (explicit request, 2026-08-02). The
        // right button additionally opens the menu below on the first
        // press; that menu is offset off the pointer so it can't intercept
        // the second one, and it is torn down with the markers when the
        // vertex actually goes.
        element.addEventListener('pointerdown', (event) => {
          const now = Date.now();
          const isDoubleTap =
            // A press that followed an actual drag isn't the second half of
            // a double-tap, however quickly it came -- otherwise nudging a
            // vertex and immediately grabbing it again would delete it.
            !draggedSinceLastTap &&
            lastTap.index === index &&
            now - lastTap.time < DOUBLE_TAP_MS &&
            Math.hypot(event.clientX - lastTap.x, event.clientY - lastTap.y) < DOUBLE_TAP_PX;

          draggedSinceLastTap = false;
          // The vertex's own screen position, not the pointer's: `drag`
          // compares against this, and map.project's origin is the canvas,
          // not the viewport.
          dragOriginPoint = map.project(marker.getLngLat());

          if (isDoubleTap) {
            lastTap = { index: -1, time: 0, x: 0, y: 0 };
            // Before removeVertex, not after: it returns early at the
            // three-vertex floor, and a refused removal must not leave the
            // map zooming in as the only visible answer to the gesture.
            suppressTapZoom();
            removeVertex(index);
            return;
          }
          lastTap = { index, time: now, x: event.clientX, y: event.clientY };
        });

        // The removal itself is handled above; this only stops the map
        // underneath from double-click-zooming on the same gesture.
        element.addEventListener('dblclick', (event) => {
          event.stopPropagation();
          event.preventDefault();
        });

        // Desktop affordance for the same action -- a double-click is easy
        // to discover on touch but not obvious with a mouse, so the right
        // button offers it explicitly (and can say *why* it's unavailable
        // at the minimum, which a silently-ignored double-click can't).
        element.addEventListener('contextmenu', (event) => {
          event.preventDefault();
          event.stopPropagation();
          openVertexMenu(event.clientX, event.clientY, index);
        });

        vertexMarkers.push(marker);
      });
    }

    // The stored centre is only a grab handle for "move the whole shape",
    // so it trails the vertices rather than defining them.
    function syncPolygonCentre() {
      const centre = polygonCentroid(area.points);
      area.lat = centre.lat;
      area.lon = centre.lon;
      centreMarker?.setLngLat([centre.lon, centre.lat]);
    }

    // clickPoint is MapLibre's {x, y} screen position for the click. Finds
    // the closest polygon edge and, if the click landed within
    // EDGE_HIT_TOLERANCE_PX of it, splits that edge at the nearest point on
    // it -- so the new vertex lands on the outline rather than wherever the
    // finger actually was, and the shape doesn't visibly jump.
    function insertVertexNearClick(clickPoint) {
      if (area.points.length >= POLYGON_MAX_POINTS) {
        showHint(t('areaMaxVerticesHint'), true);
        return;
      }

      const projected = area.points.map((p) => map.project([p.lon, p.lat]));
      let best = null;
      for (let i = 0; i < projected.length; i += 1) {
        const next = (i + 1) % projected.length;
        const { point, distance } = closestPointOnSegment(clickPoint, projected[i], projected[next]);
        if (distance <= EDGE_HIT_TOLERANCE_PX && (!best || distance < best.distance)) {
          best = { distance, insertAt: next, point };
        }
      }
      if (!best) return;

      const lngLat = map.unproject(best.point);
      area.points.splice(best.insertAt, 0, { lat: lngLat.lat, lon: lngLat.lng });
      syncPolygonCentre();
      rebuildMarkers();
      redrawShape();
    }

    function removeVertex(index) {
      if (area.points.length <= POLYGON_MIN_POINTS) {
        // Nothing encloses an area with fewer than three corners. Say so
        // rather than ignoring the gesture, which would just read as the
        // double-click not having registered.
        showHint(t('areaMinVerticesHint'), true);
        return;
      }
      area.points.splice(index, 1);
      syncPolygonCentre();
      rebuildMarkers();
      redrawShape();
    }

    // Torn down and rebuilt wholesale rather than patched, since switching
    // shape changes how many handles there are and what each one edits --
    // and for a polygon, every vertex marker's closure captures its own
    // index, which shifts as soon as one is inserted or removed.
    function rebuildMarkers() {
      removeMarkers();
      if (!area || !map) return;

      centreMarker = new maplibregl.Marker({ element: centreMarkerElement(), draggable: true, anchor: 'bottom' })
        .setLngLat([area.lon, area.lat])
        .addTo(map);

      // A polygon has no size fields to leave alone, so moving it means
      // translating every vertex by however far the pin moved. Captured at
      // dragstart because the drag handler only ever sees the new position.
      let dragFrom = null;
      centreMarker.on('dragstart', () => {
        dragFrom = { lat: area.lat, lon: area.lon };
      });

      centreMarker.on('drag', () => {
        // Dragging the pin moves the whole shape: for circle/rectangle the
        // size fields are untouched and the handles are just recomputed
        // from the new centre; for a polygon every vertex shifts with it.
        const { lng, lat } = centreMarker.getLngLat();
        if (area.kind === 'polygon' && dragFrom) {
          const dLat = lat - dragFrom.lat;
          const dLon = lng - dragFrom.lon;
          area.points = area.points.map((p) => ({ lat: p.lat + dLat, lon: p.lon + dLon }));
          dragFrom = { lat, lon: lng };
          vertexMarkers.forEach((marker, i) => marker.setLngLat([area.points[i].lon, area.points[i].lat]));
        }
        area.lat = lat;
        area.lon = lng;
        redrawShape();
        positionHandles();
      });

      if (area.kind === 'polygon') {
        addVertexMarkers();
        positionHandles();
        return;
      }

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

        // Deliberately not on 'input': rewriting the field mid-keystroke
        // would fight the user (typing "1" on the way to "150" would be
        // rewritten to the minimum instantly). 'change' fires on blur or
        // Enter -- once they've finished -- which is the right moment to
        // show what was actually stored. Without this, typing a value
        // outside [MIN_SIZE_KM, MAX_SIZE_KM] left the field showing the
        // typed number while the shape on the map used the clamped one, so
        // the two silently disagreed.
        input.addEventListener('change', syncHandleInputs);

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
      if (hintTimer) clearTimeout(hintTimer);
      hintTimer = null;
      if (tapZoomTimer) clearTimeout(tapZoomTimer);
      tapZoomTimer = null;
      map?.remove();
      map = null;
      overlay.classList.add('hidden');
      overlay.setAttribute('aria-hidden', 'true');
      overlay.innerHTML = '';
      document.removeEventListener('keydown', onKeydown);
      resolve(result);
    }

    function onKeydown(event) {
      if (event.key !== 'Escape') return;
      // Escape dismisses the vertex menu first, if one is open -- otherwise
      // reaching for it to close a menu would discard the whole edit.
      if (vertexMenuEl) {
        closeVertexMenu();
        return;
      }
      close(undefined);
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
      refreshStandingHint();
    }

    for (const button of shapeButtons) {
      button.addEventListener('click', () => {
        const kind = button.dataset.shape;
        if (kind === shapeKind) return;
        shapeKind = kind;

        const centre = map.getCenter();
        if (kind === 'rectangle') {
          // Appears immediately, centred on whatever the map is showing --
          // there's no "click to place" step for a rectangle (explicit
          // spec), so it has to land somewhere sensible on its own.
          area = {
            kind: 'rectangle',
            lat: centre.lat,
            lon: centre.lng,
            widthKm: DEFAULT_WIDTH_KM,
            heightKm: DEFAULT_HEIGHT_KM,
          };
        } else if (kind === 'polygon') {
          // Same "appears immediately" rule as the rectangle. A hexagon
          // rather than a triangle so it already looks like something to
          // reshape, and so vertices can be removed without immediately
          // hitting the three-point floor.
          const points = regularPolygonPoints(centre.lat, centre.lng, DEFAULT_POLYGON_RADIUS_KM, DEFAULT_POLYGON_SIDES);
          area = { kind: 'polygon', ...polygonCentroid(points), points };
        } else {
          // Switching to the circle drops back to click-to-place rather
          // than silently converting whatever was there: the shapes have no
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
      // Any click closes an open vertex menu, matching how a native context
      // menu behaves.
      closeVertexMenu();

      // Clicking an edge of a polygon inserts a vertex there. The edges are
      // part of the GeoJSON fill/line layers, not DOM elements, so there is
      // nothing to attach a listener to -- the click is hit-tested against
      // each segment in screen space instead, and ignored if it isn't close
      // to one (so a stray click on open map does nothing).
      if (area?.kind === 'polygon') {
        insertVertexNearClick(event.point);
        return;
      }

      if (area || shapeKind !== 'circle') return;
      area = { kind: 'circle', lat: event.lngLat.lat, lon: event.lngLat.lng, radiusKm: DEFAULT_RADIUS_KM };
      rebuildMarkers();
      redrawShape();
      syncShapeButtons();
    });
  });
}
