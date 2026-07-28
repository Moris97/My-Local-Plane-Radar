// Airline callsign: 3-letter ICAO prefix + 1-4 alphanumeric characters, the
// first of which must be a digit -- deliberately strict. This is what
// excludes most military tactical callsigns (e.g. "DUKE21": "DUK" + "E21",
// but "E" isn't a digit, so it never matches) without needing a separate
// military callsign blocklist.
const AIRLINE_CALLSIGN_PATTERN = /^([A-Z]{3})([0-9][0-9A-Z]{0,3})$/;

// Optional/nice-to-have diagnostic, explicitly called out as not required
// when this feature was specced (2026-07-27): a well-formed airline-style
// callsign whose 3-letter prefix isn't in OpenFlights' airlines.dat was
// silently ignored. Logged once per distinct prefix per process lifetime
// (not once per aircraft/tick, which would spam the log for a frequently-
// seen aircraft) so `journalctl -u mlpr@...` occasionally shows what's
// missing and worth an upstream OpenFlights update. Plain console.warn
// rather than threading a pino logger in from server.js -- this module is
// several layers away from the Fastify instance, purely a pure classifier,
// and it's not worth the interface churn for a diagnostic like this one.
const loggedUnmatchedPrefixes = new Set();

function logUnmatchedPrefixOnce(icao, callsign) {
  if (loggedUnmatchedPrefixes.has(icao)) return;
  loggedUnmatchedPrefixes.add(icao);
  console.warn(`[airline-lookup] unmatched airline callsign prefix "${icao}" (callsign "${callsign}") -- not in OpenFlights airlines.dat`);
}

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
  if (!airline) {
    logUnmatchedPrefixOnce(icao, callsign);
    return { kind: 'airline_unknown', icao };
  }

  return { kind: 'airline', icao, flightNumber: match[2], ...airline };
}

// Convenience accessor for the one thing stats-registrations.js actually
// needs to persist -- callers that want the full classification (e.g. a
// future "operator" badge in the UI) should use identifyOperator directly.
export function resolveAirlineIcao(aircraft, airlines) {
  const result = identifyOperator(aircraft, airlines);
  return result.kind === 'airline' ? result.icao : null;
}
