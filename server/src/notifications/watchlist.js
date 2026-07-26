import { randomBytes } from 'node:crypto';
import { getConfigJSON, setConfigJSON } from '../db.js';

const WATCHLIST_KEY = 'watchList';
const MATCH_TYPES = new Set(['type', 'registration', 'flight']);
const ALTITUDE_OPERATORS = new Set(['below', 'above']);

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

  return null;
}

export function addWatchEntry(input) {
  const entry = {
    id: randomBytes(6).toString('hex'),
    matchType: input.matchType,
    matchValue: input.matchValue.trim(),
    altitudeOperator: input.altitudeOperator ?? null,
    altitudeValue: input.altitudeOperator ? input.altitudeValue : null,
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
