import { randomBytes } from 'node:crypto';
import { getConfigJSON, setConfigJSON } from '../db.js';

const WATCHLIST_KEY = 'watchList';
const MATCH_TYPES = new Set(['type', 'registration', 'flight']);
const ALTITUDE_OPERATORS = new Set(['below', 'above']);

// Optional per-entry trigger area ("only notify when this aircraft is
// inside this region"). The `kind` discriminator was there from the first
// (circle-only) version precisely so more shapes could be added without
// migrating already-stored entries -- 'rectangle' joined it 2026-08-01,
// free-form polygon is still to come (see TODO.md).
//
// Every shape is centre-anchored (`lat`/`lon` plus its own size fields)
// rather than corner- or vertex-based: it keeps "drag the middle to move
// the whole thing" uniform across shapes, and matches how the editor's
// centre pin works.
//
// The centre is an arbitrary lat/lon, NOT the receiver's home location:
// the whole point is watching a *specific* piece of sky that isn't
// necessarily overhead -- e.g. an airfield or an approach path 15 km away
// (explicit requirement, 2026-08-01). Nothing here reads home.js at all.
//
// All distances are stored in km regardless of the user's display
// preference, same as every other distance the server persists (range.js,
// antenna-stats.js); the client converts for display only.
const AREA_KINDS = new Set(['circle', 'rectangle']);

// Per-shape size fields, all of which must be finite and positive. Adding a
// shape means adding a line here plus a branch in rules.js's
// satisfiesAreaCondition -- nothing else in this file changes.
const AREA_SIZE_FIELDS = {
  circle: ['radiusKm'],
  rectangle: ['widthKm', 'heightKm'],
};

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

export function validateArea(area) {
  if (area === null || area === undefined) return null;
  if (typeof area !== 'object') return 'area must be an object or null';
  if (!AREA_KINDS.has(area.kind)) return 'area.kind must be "circle" or "rectangle"';

  if (!isFiniteNumber(area.lat) || area.lat < -90 || area.lat > 90) {
    return 'area.lat must be a number between -90 and 90';
  }
  if (!isFiniteNumber(area.lon) || area.lon < -180 || area.lon > 180) {
    return 'area.lon must be a number between -180 and 180';
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
// list below rather than spreading `input`.
function normalizeArea(area) {
  if (!area) return null;
  const normalized = { kind: area.kind, lat: area.lat, lon: area.lon };
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
