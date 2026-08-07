const EARTH_RADIUS_KM = 6371;

// Every distance this app stores or persists goes through here first: 10 m
// precision, which is already far finer than anything drawn ("434 km") or
// compared. A raw double serializes as ~17 characters of noise, and both
// the antenna-coverage cells and the stats-history snapshot are persisted
// as JSON config blobs where that noise dominates the payload -- a real SD
// write cost (hard rule: batch writes, minimize SD wear).
const KM_PRECISION = 100;
export function roundKm(km) {
  return Math.round(km * KM_PRECISION) / KM_PRECISION;
}

// Whether an aircraft's *position* says anything meaningful about this
// receiver's own reception range. Only true ADS-B ("adsb_icao",
// "adsb_icao_nt", "adsb_other") qualifies -- MLAT positions are computed
// from several receivers' message timing, so a distant MLAT contact can
// mean stations on the other side of the country triangulated it, not that
// this antenna actually heard it that far out (reported live, 2026-07-28:
// a Stats/coverage-map range figure inflated by exactly this). Everything
// else (mlat, mode_s, adsc, adsr_*, tisb_*, other) is excluded the same
// way, simply by not matching the adsb_ prefix -- not an oversight, that's
// the literal filter asked for. Used to gate range/antenna sampling only;
// deliberately not applied anywhere position itself is displayed (the map,
// the details panel) -- an MLAT contact is still a real aircraft, just not
// trustworthy evidence of *this* antenna's range.
export function isRangeEligible(sourceType) {
  return typeof sourceType === 'string' && sourceType.startsWith('adsb_');
}

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

const KM_PER_KT = 1.852; // 1 knot = 1 nautical mile/hour, exactly

// For the overhead-proximity notification (rules.js): given an aircraft's
// current position, course and ground speed, when and how close will it
// come to `home`, assuming it holds that course? Aircraft close enough to
// trigger this rule are within a few km of home, well inside the range
// where treating the local patch of Earth as flat introduces no error this
// use case could ever notice -- so position relative to home is resolved
// once via distanceKm/bearingDegrees (both already exact) into a local
// east/north plane in km, and the rest is plane closest-point-of-approach
// algebra: position(t) = p0 + v*t, minimize |position(t)|^2 over t.
//
// Returns null, not a stale/negative ETA, when there is nothing meaningful
// to report: no track/speed to project from, sitting still, or the closest
// point on the current course already lies in the past (the aircraft is
// moving away, or was already at its closest as of this fix). The caller's
// job is deciding what "nothing to report" means for its message -- this
// only ever answers "is there a real future closest approach, and if so
// when/where".
export function closestApproach(homeLat, homeLon, lat, lon, trackDeg, groundSpeedKt) {
  if (typeof trackDeg !== 'number' || typeof groundSpeedKt !== 'number' || groundSpeedKt <= 0) return null;

  const bearing = toRadians(bearingDegrees(homeLat, homeLon, lat, lon));
  const distance = distanceKm(homeLat, homeLon, lat, lon);
  const x = distance * Math.sin(bearing); // km east of home
  const y = distance * Math.cos(bearing); // km north of home

  const track = toRadians(trackDeg);
  const speedKmh = groundSpeedKt * KM_PER_KT;
  const vx = speedKmh * Math.sin(track);
  const vy = speedKmh * Math.cos(track);

  // t minimizing (x+vx*t)^2 + (y+vy*t)^2 -- the standard closest-point-of-
  // approach result, derivative set to zero. Denominator is speedKmh^2,
  // already guaranteed > 0 by the groundSpeedKt check above.
  const etaHours = -(x * vx + y * vy) / (vx * vx + vy * vy);
  if (etaHours <= 0) return null;

  const cpaX = x + vx * etaHours;
  const cpaY = y + vy * etaHours;

  return {
    etaSeconds: etaHours * 3600,
    cpaDistanceKm: Math.sqrt(cpaX * cpaX + cpaY * cpaY),
  };
}
