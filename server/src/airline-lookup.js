// Airline callsign: 3-letter ICAO prefix + 1-4 alphanumeric characters, the
// first of which must be a digit -- deliberately strict. This is what
// excludes most military tactical callsigns (e.g. "DUKE21": "DUK" + "E21",
// but "E" isn't a digit, so it never matches) without needing a separate
// military callsign blocklist.
const AIRLINE_CALLSIGN_PATTERN = /^([A-Z]{3})([0-9][0-9A-Z]{0,3})$/;

// aircraft: our normalized shape (server/src/normalize.js) -- flight,
// registration, military (already decoded from dbFlags bit 1).
// airlines: Map<icaoCode, {name, country}>, loaded from data/airlines.json.
export function identifyOperator(aircraft, airlines) {
  if (aircraft.military) return { kind: 'military' };

  const callsign = (aircraft.flight ?? '').trim().toUpperCase();
  if (!callsign) return { kind: 'unknown' };

  const registration = (aircraft.registration ?? '').replace(/-/g, '').toUpperCase();
  if (registration && callsign === registration) {
    return { kind: 'private', registration: aircraft.registration };
  }

  const match = callsign.match(AIRLINE_CALLSIGN_PATTERN);
  if (!match) return { kind: 'unknown', callsign };

  const icao = match[1];
  const airline = airlines.get(icao);
  if (!airline) return { kind: 'airline_unknown', icao };

  return { kind: 'airline', icao, flightNumber: match[2], ...airline };
}

// Convenience accessor for the one thing stats-registrations.js actually
// needs to persist -- callers that want the full classification (e.g. a
// future "operator" badge in the UI) should use identifyOperator directly.
export function resolveAirlineIcao(aircraft, airlines) {
  const result = identifyOperator(aircraft, airlines);
  return result.kind === 'airline' ? result.icao : null;
}
