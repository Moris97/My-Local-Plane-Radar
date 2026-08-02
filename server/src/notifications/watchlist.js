import { randomBytes } from 'node:crypto';
import { getConfigJSON, setConfigJSON } from '../db.js';

const WATCHLIST_KEY = 'watchList';
const MATCH_TYPES = new Set(['type', 'registration', 'flight']);
const ALTITUDE_OPERATORS = new Set(['below', 'above']);

// Optional per-entry trigger area ("only notify when this aircraft is
// inside this region"). The `kind` discriminator was there from the first
// (circle-only) version precisely so more shapes could be added without
// migrating already-stored entries -- 'rectangle' joined it 2026-08-01,
// 'polygon' on 2026-08-02.
//
// Every shape carries a `lat`/`lon` centre, which is what the editor's
// centre pin drags to move the whole shape. Circle and rectangle are
// *defined* by that centre plus size fields; a polygon is defined by its
// vertex list instead, and its centre is a derived convenience (the
// centroid the client keeps up to date). That's why polygon gets its own
// branch below rather than another AREA_SIZE_FIELDS row -- it's the one
// shape that doesn't fit the centre+size model.
//
// The centre is an arbitrary lat/lon, NOT the receiver's home location:
// the whole point is watching a *specific* piece of sky that isn't
// necessarily overhead -- e.g. an airfield or an approach path 15 km away
// (explicit requirement, 2026-08-01). Nothing here reads home.js at all.
//
// All distances are stored in km regardless of the user's display
// preference, same as every other distance the server persists (range.js,
// antenna-stats.js); the client converts for display only.
const AREA_KINDS = new Set(['circle', 'rectangle', 'polygon']);

// Per-shape size fields, all of which must be finite and positive. Adding a
// centre+size shape means adding a line here plus a branch in rules.js's
// satisfiesAreaCondition -- nothing else in this file changes. Polygon is
// deliberately absent: it has no size fields, see POLYGON_* below.
const AREA_SIZE_FIELDS = {
  circle: ['radiusKm'],
  rectangle: ['widthKm', 'heightKm'],
};

// Three is the least that encloses any area at all. The upper bound is not
// about geometry -- it's that this ends up as JSON in the SQLite `config`
// table, and hard rule 4/5 are about keeping that table small and its
// writes rare. 60 vertices is far more than anyone traces by hand around an
// airfield, while keeping a single entry to roughly two kilobytes.
const POLYGON_MIN_POINTS = 3;
const POLYGON_MAX_POINTS = 60;

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function isValidLat(value) {
  return isFiniteNumber(value) && value >= -90 && value <= 90;
}

function isValidLon(value) {
  return isFiniteNumber(value) && value >= -180 && value <= 180;
}

export function validateArea(area) {
  if (area === null || area === undefined) return null;
  if (typeof area !== 'object') return 'area must be an object or null';
  if (!AREA_KINDS.has(area.kind)) return 'area.kind must be "circle", "rectangle" or "polygon"';

  if (!isValidLat(area.lat)) return 'area.lat must be a number between -90 and 90';
  if (!isValidLon(area.lon)) return 'area.lon must be a number between -180 and 180';

  if (area.kind === 'polygon') {
    if (!Array.isArray(area.points)) return 'area.points must be an array';
    if (area.points.length < POLYGON_MIN_POINTS) {
      return `area.points must have at least ${POLYGON_MIN_POINTS} points`;
    }
    if (area.points.length > POLYGON_MAX_POINTS) {
      return `area.points must have at most ${POLYGON_MAX_POINTS} points`;
    }
    for (const point of area.points) {
      if (!point || typeof point !== 'object') return 'each area.points entry must be an object';
      if (!isValidLat(point.lat)) return 'each area.points entry needs a lat between -90 and 90';
      if (!isValidLon(point.lon)) return 'each area.points entry needs a lon between -180 and 180';
    }
    return null;
  }

  for (const field of AREA_SIZE_FIELDS[area.kind]) {
    if (!isFiniteNumber(area[field]) || area[field] <= 0) {
      return `area.${field} must be a positive number`;
    }
  }

  return null;
}

// Only the recognised fields, so a client can't smuggle arbitrary keys into
// the stored config blob -- same spirit as addWatchEntry's explicit field
// list below rather than spreading `input`. Applies to the points too: a
// vertex is exactly {lat, lon}, nothing else.
function normalizeArea(area) {
  if (!area) return null;
  const normalized = { kind: area.kind, lat: area.lat, lon: area.lon };

  if (area.kind === 'polygon') {
    normalized.points = area.points.map((point) => ({ lat: point.lat, lon: point.lon }));
    return normalized;
  }

  for (const field of AREA_SIZE_FIELDS[area.kind]) {
    normalized[field] = area[field];
  }
  return normalized;
}

export function getWatchList() {
  return getConfigJSON(WATCHLIST_KEY, []);
}

function setWatchList(list) {
  setConfigJSON(WATCHLIST_KEY, list);
}

export function validateWatchEntryInput(input) {
  if (!input || typeof input !== 'object') return 'Invalid entry';
  if (!MATCH_TYPES.has(input.matchType)) return 'matchType must be one of: type, registration, flight';
  if (typeof input.matchValue !== 'string' || input.matchValue.trim().length === 0) {
    return 'matchValue must be a non-empty string';
  }

  if (input.altitudeOperator !== null && input.altitudeOperator !== undefined) {
    if (!ALTITUDE_OPERATORS.has(input.altitudeOperator)) {
      return 'altitudeOperator must be "below", "above", or null';
    }
    if (typeof input.altitudeValue !== 'number' || !Number.isFinite(input.altitudeValue)) {
      return 'altitudeValue must be a number when altitudeOperator is set';
    }
  }

  return validateArea(input.area);
}

export function addWatchEntry(input) {
  const entry = {
    id: randomBytes(6).toString('hex'),
    matchType: input.matchType,
    matchValue: input.matchValue.trim(),
    altitudeOperator: input.altitudeOperator ?? null,
    altitudeValue: input.altitudeOperator ? input.altitudeValue : null,
    area: normalizeArea(input.area),
  };
  const list = getWatchList();
  list.push(entry);
  setWatchList(list);
  return entry;
}

export function removeWatchEntry(id) {
  const list = getWatchList();
  const next = list.filter((entry) => entry.id !== id);
  setWatchList(next);
  return next.length !== list.length;
}
