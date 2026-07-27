// Sunrise/sunset for the "automatic" map theme (Settings -> Map): light
// between sunrise and sunset, dark otherwise. Implements the standard
// sunrise equation (the NOAA/Wikipedia formulation) -- ~40 lines of pure
// trigonometry, so no new dependency for this.
//
// Deliberately server-side: the browser needs to know whether it's
// currently daylight *at the receiver*, and the receiver's coordinates are
// the user's home location. Exposing a plain "is it daylight" boolean keeps
// those coordinates from having to be handed to every browser that loads
// the page (see the home-location privacy note in CLAUDE.md).

const J2000 = 2451545.0;
const UNIX_EPOCH_JULIAN_DAY = 2440587.5;
const MS_PER_DAY = 86400000;
// Standard "sun's upper limb touches the horizon, corrected for refraction"
// zenith used for official sunrise/sunset times.
const SUN_ANGLE_DEG = -0.833;

const toRad = (deg) => (deg * Math.PI) / 180;
const toDeg = (rad) => (rad * 180) / Math.PI;

function julianDayFromMs(ms) {
  return ms / MS_PER_DAY + UNIX_EPOCH_JULIAN_DAY;
}

function msFromJulianDay(jd) {
  return (jd - UNIX_EPOCH_JULIAN_DAY) * MS_PER_DAY;
}

// Returns { sunriseMs, sunsetMs } for the solar day containing `atMs`, or
// null during polar day/night, where the sun never crosses the horizon and
// the hour-angle equation has no solution.
export function sunTimes(lat, lon, atMs) {
  const n = Math.round(julianDayFromMs(atMs) - J2000 + 0.0008);

  // `lon` is east-positive (the convention used everywhere else in MLPR and
  // by readsb), so solar noon happens *earlier* in UTC the further east the
  // receiver is -- hence subtracting. Textbook statements of this equation
  // are usually written for west-positive longitude and read `+ l_w / 360`;
  // getting that sign backwards shifts every result by twice the offset
  // (2 x 1.4 h for Poland), which the solstice tests below catch.
  const meanSolarNoon = n - lon / 360;
  const meanAnomaly = (357.5291 + 0.98560028 * meanSolarNoon) % 360;
  const center =
    1.9148 * Math.sin(toRad(meanAnomaly)) +
    0.02 * Math.sin(toRad(2 * meanAnomaly)) +
    0.0003 * Math.sin(toRad(3 * meanAnomaly));
  const eclipticLon = (meanAnomaly + center + 180 + 102.9372) % 360;

  const solarTransit =
    J2000 + meanSolarNoon + 0.0053 * Math.sin(toRad(meanAnomaly)) - 0.0069 * Math.sin(toRad(2 * eclipticLon));

  const declination = Math.asin(Math.sin(toRad(eclipticLon)) * Math.sin(toRad(23.4397)));

  const cosHourAngle =
    (Math.sin(toRad(SUN_ANGLE_DEG)) - Math.sin(toRad(lat)) * Math.sin(declination)) /
    (Math.cos(toRad(lat)) * Math.cos(declination));

  // |cos| > 1 means the sun stays either entirely above or entirely below
  // the horizon all day (polar summer/winter).
  if (cosHourAngle > 1 || cosHourAngle < -1) return null;

  const hourAngle = toDeg(Math.acos(cosHourAngle));

  return {
    sunriseMs: msFromJulianDay(solarTransit - hourAngle / 360),
    sunsetMs: msFromJulianDay(solarTransit + hourAngle / 360),
  };
}

// true = daylight, false = night. During polar day/night there are no
// sunrise/sunset times at all, so fall back to the sun's declination vs. the
// hemisphere: the sun is up all day iff its declination has the same sign as
// the latitude.
export function isDaylight(lat, lon, atMs = Date.now()) {
  const times = sunTimes(lat, lon, atMs);
  if (times === null) {
    const n = Math.round(julianDayFromMs(atMs) - J2000 + 0.0008);
    const meanAnomaly = (357.5291 + 0.98560028 * n) % 360;
    const center =
      1.9148 * Math.sin(toRad(meanAnomaly)) +
      0.02 * Math.sin(toRad(2 * meanAnomaly)) +
      0.0003 * Math.sin(toRad(3 * meanAnomaly));
    const eclipticLon = (meanAnomaly + center + 180 + 102.9372) % 360;
    const declination = Math.asin(Math.sin(toRad(eclipticLon)) * Math.sin(toRad(23.4397)));
    return declination * lat > 0;
  }
  return atMs >= times.sunriseMs && atMs < times.sunsetMs;
}
