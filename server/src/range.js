const EARTH_RADIUS_KM = 6371;

function toRadians(degrees) {
  return (degrees * Math.PI) / 180;
}

function toDegrees(radians) {
  return (radians * 180) / Math.PI;
}

export function distanceKm(lat1, lon1, lat2, lon2) {
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_KM * c;
}

// Initial great-circle bearing from point 1 to point 2, in degrees, 0-360,
// 0 = true north, clockwise (standard compass bearing formula). Used to
// bucket an aircraft's position into a compass sector relative to home, for
// the antenna "directional coverage" stats -- see antenna-stats.js.
export function bearingDegrees(lat1, lon1, lat2, lon2) {
  const phi1 = toRadians(lat1);
  const phi2 = toRadians(lat2);
  const dLon = toRadians(lon2 - lon1);
  const y = Math.sin(dLon) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLon);
  const theta = Math.atan2(y, x);
  return ((theta * 180) / Math.PI + 360) % 360;
}

// The inverse of the pair above: given a start point, a bearing, and a
// distance, where do you end up? Standard direct-geodesic (on a sphere)
// formula. Used to turn antenna-stats.js's per-sector (bearing, range)
// pairs into real map coordinates for the coverage layer's polygon --
// see server.js's /api/stats/antenna/coverage.
export function destinationPoint(lat, lon, bearingDeg, distanceKm) {
  const angularDistance = distanceKm / EARTH_RADIUS_KM;
  const bearing = toRadians(bearingDeg);
  const lat1 = toRadians(lat);
  const lon1 = toRadians(lon);

  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(angularDistance) + Math.cos(lat1) * Math.sin(angularDistance) * Math.cos(bearing),
  );
  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(lat1),
      Math.cos(angularDistance) - Math.sin(lat1) * Math.sin(lat2),
    );

  // Normalize longitude back into [-180, 180] -- atan2 above can push it
  // just outside that range near the antimeridian. The extra "+360, %360"
  // guards against JS's %-with-negative-operand behavior (e.g. -20 % 360
  // is -20, not 340) rather than assuming the first term is already positive.
  const lon2Deg = ((((toDegrees(lon2) + 180) % 360) + 360) % 360) - 180;
  return { lat: toDegrees(lat2), lon: lon2Deg };
}
