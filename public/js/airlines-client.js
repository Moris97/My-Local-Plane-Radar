// Client-side cache of ICAO code -> {name, country}, fetched once from
// GET /api/airlines (server/src/airlines-data.js, itself loaded once from
// data/airlines.json at server startup). Same fetch-once-and-cache shape as
// icon-classify.js's loadIconTypes/getIconTypes, so an aircraft's airline
// name is available wherever it's needed -- the map popup, the aircraft
// details panel, Stats -- without each caller re-fetching or keeping its
// own copy. app.js calls loadAirlines() once, alongside loadIconTypes(),
// inside map.on('load') -- well before the first snapshot could open a
// popup or a details panel.
let airlines = null;
let loadPromise = null;

export function loadAirlines(url = '/api/airlines') {
  if (!loadPromise) {
    loadPromise = fetch(url)
      .then((response) => (response.ok ? response.json() : {}))
      .catch(() => ({}))
      .then((data) => {
        airlines = new Map(Object.entries(data));
        return airlines;
      });
  }
  return loadPromise;
}

// Sync accessor -- returns null both before loadAirlines() resolves and for
// an aircraft.airlineIcao the loaded map has no entry for (an unmatched
// prefix airline-lookup.js already logs server-side, see that file's own
// comment). Callers should treat "no name" as "don't show an airline tile
// at all" rather than a placeholder, same as every other optional field in
// the details panel/popup.
export function getAirlineName(icao) {
  if (!icao) return null;
  return airlines?.get(icao)?.name ?? null;
}

// The full Map, for callers that need more than just a name lookup (Stats'
// registrations/all-airlines tables already resolve by icao -> {name,...}).
export function getAirlinesMap() {
  return airlines;
}
