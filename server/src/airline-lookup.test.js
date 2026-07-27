import { test } from 'node:test';
import assert from 'node:assert/strict';
import { identifyOperator, resolveAirlineIcao } from './airline-lookup.js';

function airlines() {
  return new Map([
    ['RYR', { name: 'Ryanair', country: 'Ireland' }],
    ['LOT', { name: 'LOT Polish Airlines', country: 'Poland' }],
  ]);
}

test('military aircraft are classified as military, regardless of callsign shape', () => {
  const result = identifyOperator({ flight: 'RYR4571', military: true }, airlines());
  assert.equal(result.kind, 'military');
});

test('a callsign equal to the registration (dashes stripped) is private/GA, not an airline', () => {
  const result = identifyOperator({ flight: 'SPKWA', registration: 'SP-KWA', military: false }, airlines());
  assert.equal(result.kind, 'private');
});

test('a known airline ICAO prefix resolves to the airline, with flight number and metadata', () => {
  const result = identifyOperator({ flight: 'RYR4571 ', registration: null, military: false }, airlines());
  assert.equal(result.kind, 'airline');
  assert.equal(result.icao, 'RYR');
  assert.equal(result.name, 'Ryanair');
  assert.equal(result.country, 'Ireland');
  assert.equal(result.flightNumber, '4571');
});

test('an airline-shaped callsign with an unknown ICAO prefix is airline_unknown, not private/unknown', () => {
  const result = identifyOperator({ flight: 'ZZZ123', registration: null, military: false }, airlines());
  assert.equal(result.kind, 'airline_unknown');
  assert.equal(result.icao, 'ZZZ');
});

test('a missing callsign is unknown', () => {
  const result = identifyOperator({ flight: null, registration: 'SP-TEST', military: false }, airlines());
  assert.equal(result.kind, 'unknown');
});

test('a callsign not matching the airline pattern (e.g. a bare N-number) is unknown', () => {
  const result = identifyOperator({ flight: 'N1234A', registration: null, military: false }, airlines());
  assert.equal(result.kind, 'unknown');
});

test('a military-style tactical callsign without the military flag set still requires a digit right after the prefix', () => {
  // "DUKE21" -> prefix "DUK", remainder "E21" -- fails because "E" isn't a
  // digit, so it correctly falls through to unknown rather than matching
  // some unrelated 3-letter code.
  const result = identifyOperator({ flight: 'DUKE21', registration: null, military: false }, airlines());
  assert.equal(result.kind, 'unknown');
});

test('resolveAirlineIcao returns the ICAO code only for a recognized airline, null otherwise', () => {
  assert.equal(resolveAirlineIcao({ flight: 'LOT283', registration: null, military: false }, airlines()), 'LOT');
  assert.equal(resolveAirlineIcao({ flight: 'ZZZ123', registration: null, military: false }, airlines()), null);
  assert.equal(resolveAirlineIcao({ flight: 'RYR123', registration: null, military: true }, airlines()), null);
});

test('trailing spaces in the callsign (as readsb sends it) do not break matching', () => {
  const result = identifyOperator({ flight: 'LOT283  ', registration: null, military: false }, airlines());
  assert.equal(result.kind, 'airline');
  assert.equal(result.icao, 'LOT');
});
