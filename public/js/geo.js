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

function toDegrees(radians) {
  return (radians * 180) / Math.PI;
}

// Third of the same family as the two above, duplicated from
// server/src/range.js for the same reason: given a start point, a bearing
// and a distance, where do you end up? Used by the trigger-area editor to
// place the circle's resize handle and to build its outline.
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

  // Same antimeridian normalisation as range.js's copy -- see the comment
  // there on why the extra "+360, %360" is needed rather than a bare %.
  const lon2Deg = ((((toDegrees(lon2) + 180) % 360) + 360) % 360) - 180;
  return { lat: toDegrees(lat2), lon: lon2Deg };
}

// A circle on the globe is not a circle on a projected map (it stretches
// with latitude), so it's drawn as a polygon of points all exactly
// radiusKm away from the centre rather than a fixed-radius screen circle.
// Returns a closed GeoJSON linear ring ([lon, lat] pairs, first point
// repeated last), ready to drop straight into a Polygon geometry.
export function circleRing(lat, lon, radiusKm, steps = 128) {
  const ring = [];
  for (let i = 0; i < steps; i += 1) {
    const point = destinationPoint(lat, lon, (i * 360) / steps, radiusKm);
    ring.push([point.lon, point.lat]);
  }
  ring.push(ring[0]);
  return ring;
}

// Edge distances of a centre-anchored, lat/lon-aligned box. Kept as its own
// export (rather than inlined into rectangleRing) because the editor needs
// the individual edges too, to place the resize handles on them.
// server/src/notifications/rules.js derives the same four numbers the same
// way, so "inside the box on screen" and "matches the rule" cannot drift.
export function rectangleEdges(lat, lon, widthKm, heightKm) {
  return {
    north: destinationPoint(lat, lon, 0, heightKm / 2).lat,
    south: destinationPoint(lat, lon, 180, heightKm / 2).lat,
    east: destinationPoint(lat, lon, 90, widthKm / 2).lon,
    west: destinationPoint(lat, lon, 270, widthKm / 2).lon,
  };
}

// Only four corners are needed, unlike circleRing's 128 points: a
// lat/lon-aligned box is a true rectangle in Web Mercator (constant
// latitude renders horizontal, constant longitude vertical), so subdividing
// the edges would add vertices that all land exactly on the straight lines
// already drawn between the corners.
export function rectangleRing(lat, lon, widthKm, heightKm) {
  const { north, south, east, west } = rectangleEdges(lat, lon, widthKm, heightKm);
  return [
    [west, north],
    [east, north],
    [east, south],
    [west, south],
    [west, north],
  ];
}

// points: [{lat, lon}, ...] in order. Returns the closed GeoJSON ring.
// Nothing is interpolated between vertices, deliberately: the server's
// point-in-polygon test treats the edges as straight lines in lat/lon too,
// so drawing them any other way would make the shape on screen disagree
// with the shape that actually matches.
export function polygonRing(points) {
  const ring = points.map((point) => [point.lon, point.lat]);
  ring.push(ring[0]);
  return ring;
}

// Plain average of the vertices, not the area-weighted centroid. For the
// editor's "drag the middle to move the whole shape" pin that's the better
// behaviour: it always sits inside a convex shape, moves predictably as
// vertices are added, and -- unlike the true centroid -- doesn't lurch
// sideways when the user adds several vertices along one edge. It is never
// used for matching, only as a grab handle and as the stored `lat`/`lon`.
export function polygonCentroid(points) {
  const sum = points.reduce((acc, p) => ({ lat: acc.lat + p.lat, lon: acc.lon + p.lon }), { lat: 0, lon: 0 });
  return { lat: sum.lat / points.length, lon: sum.lon / points.length };
}

// A regular n-gon around a centre, used for the shape a fresh free-form
// area starts as. Starts at due north so the first vertex sits at the top,
// which is what someone expects to grab first.
export function regularPolygonPoints(lat, lon, radiusKm, sides) {
  return Array.from({ length: sides }, (_, i) => destinationPoint(lat, lon, (i * 360) / sides, radiusKm));
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
