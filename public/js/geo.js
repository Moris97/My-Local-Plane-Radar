// Client-side counterpart of server/src/range.js's distanceKm/bearingDegrees
// -- small enough (and crossing the server/browser module boundary, which
// this codebase has no shared-code mechanism for) that duplicating the two
// pure formulas here is simpler than trying to share one module between
// server/src and public/js. Used for the "Aktualnie" section's nearest/
// farthest-aircraft tiles, computed entirely client-side from data the
// browser already has (the live aircraft list, and the home location the
// browser already fetches for the home marker).

const EARTH_RADIUS_KM = 6371;

function toRadians(degrees) {
  return (degrees * Math.PI) / 180;
}

export function distanceKm(lat1, lon1, lat2, lon2) {
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_KM * c;
}

export function bearingDegrees(lat1, lon1, lat2, lon2) {
  const phi1 = toRadians(lat1);
  const phi2 = toRadians(lat2);
  const dLon = toRadians(lon2 - lon1);
  const y = Math.sin(dLon) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLon);
  const theta = Math.atan2(y, x);
  return ((theta * 180) / Math.PI + 360) % 360;
}

// aircraftList: normalized aircraft objects (radar-state.js's getLiveAircraft()).
// home: { lat, lon } | null. Returns { nearest, farthest }, each either null
// (no home configured, or no aircraft with a position) or the original
// aircraft object plus a distanceKm field -- the "Aktualnie" section reads
// registration/typeCode/flight/altBaro/onGround/gs straight off it.
export function findNearestFarthest(aircraftList, home) {
  if (!home) return { nearest: null, farthest: null };

  let nearest = null;
  let farthest = null;

  for (const aircraft of aircraftList) {
    if (typeof aircraft.lat !== 'number' || typeof aircraft.lon !== 'number') continue;
    const distanceKmValue = distanceKm(home.lat, home.lon, aircraft.lat, aircraft.lon);
    const withDistance = { ...aircraft, distanceKm: distanceKmValue };
    if (!nearest || distanceKmValue < nearest.distanceKm) nearest = withDistance;
    if (!farthest || distanceKmValue > farthest.distanceKm) farthest = withDistance;
  }

  return { nearest, farthest };
}
