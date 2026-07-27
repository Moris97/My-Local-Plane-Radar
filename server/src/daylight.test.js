import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sunTimes, isDaylight } from './daylight.js';

// Placeholder coordinates only -- never the user's real receiver position
// (see CLAUDE.md). 52.23/21.01 is Warsaw, used here because its sunrise and
// sunset times are easy to verify against published almanac data.
const WARSAW = { lat: 52.23, lon: 21.01 };

function hoursUtc(ms) {
  const d = new Date(ms);
  return d.getUTCHours() + d.getUTCMinutes() / 60;
}

test('sunrise/sunset at the summer solstice match published times within a few minutes', () => {
  // Warsaw, 2026-06-21: sunrise ~04:14 local (CEST = UTC+2) -> ~02:14 UTC,
  // sunset ~21:00 local -> ~19:00 UTC.
  const noon = Date.UTC(2026, 5, 21, 12, 0, 0);
  const { sunriseMs, sunsetMs } = sunTimes(WARSAW.lat, WARSAW.lon, noon);

  assert.ok(Math.abs(hoursUtc(sunriseMs) - 2.23) < 0.15, `sunrise was ${hoursUtc(sunriseMs)}h UTC`);
  assert.ok(Math.abs(hoursUtc(sunsetMs) - 19.0) < 0.15, `sunset was ${hoursUtc(sunsetMs)}h UTC`);
});

test('sunrise/sunset at the winter solstice match published times within a few minutes', () => {
  // Warsaw, 2026-12-21: sunrise ~07:44 local (CET = UTC+1) -> ~06:44 UTC,
  // sunset ~15:24 local -> ~14:24 UTC.
  const noon = Date.UTC(2026, 11, 21, 12, 0, 0);
  const { sunriseMs, sunsetMs } = sunTimes(WARSAW.lat, WARSAW.lon, noon);

  assert.ok(Math.abs(hoursUtc(sunriseMs) - 6.73) < 0.15, `sunrise was ${hoursUtc(sunriseMs)}h UTC`);
  assert.ok(Math.abs(hoursUtc(sunsetMs) - 14.4) < 0.15, `sunset was ${hoursUtc(sunsetMs)}h UTC`);
});

test('summer days are much longer than winter days at temperate latitudes', () => {
  const summer = sunTimes(WARSAW.lat, WARSAW.lon, Date.UTC(2026, 5, 21, 12));
  const winter = sunTimes(WARSAW.lat, WARSAW.lon, Date.UTC(2026, 11, 21, 12));

  const summerHours = (summer.sunsetMs - summer.sunriseMs) / 3600000;
  const winterHours = (winter.sunsetMs - winter.sunriseMs) / 3600000;

  assert.ok(summerHours > 16, `expected a long summer day, got ${summerHours}h`);
  assert.ok(winterHours < 8.5, `expected a short winter day, got ${winterHours}h`);
});

test('isDaylight is true around local noon and false around local midnight', () => {
  assert.equal(isDaylight(WARSAW.lat, WARSAW.lon, Date.UTC(2026, 5, 21, 10)), true);
  assert.equal(isDaylight(WARSAW.lat, WARSAW.lon, Date.UTC(2026, 5, 21, 23)), false);
  assert.equal(isDaylight(WARSAW.lat, WARSAW.lon, Date.UTC(2026, 11, 21, 12)), true);
  assert.equal(isDaylight(WARSAW.lat, WARSAW.lon, Date.UTC(2026, 11, 21, 3)), false);
});

test('isDaylight flips exactly at the computed sunrise and sunset', () => {
  const noon = Date.UTC(2026, 5, 21, 12);
  const { sunriseMs, sunsetMs } = sunTimes(WARSAW.lat, WARSAW.lon, noon);

  assert.equal(isDaylight(WARSAW.lat, WARSAW.lon, sunriseMs - 60000), false);
  assert.equal(isDaylight(WARSAW.lat, WARSAW.lon, sunriseMs + 60000), true);
  assert.equal(isDaylight(WARSAW.lat, WARSAW.lon, sunsetMs - 60000), true);
  assert.equal(isDaylight(WARSAW.lat, WARSAW.lon, sunsetMs + 60000), false);
});

test('polar day and polar night have no sunrise/sunset, and isDaylight still answers sensibly', () => {
  const svalbardLat = 78.2;
  const svalbardLon = 15.6;

  // Midsummer above the Arctic circle: sun never sets.
  assert.equal(sunTimes(svalbardLat, svalbardLon, Date.UTC(2026, 5, 21, 12)), null);
  assert.equal(isDaylight(svalbardLat, svalbardLon, Date.UTC(2026, 5, 21, 2)), true);

  // Midwinter: sun never rises.
  assert.equal(sunTimes(svalbardLat, svalbardLon, Date.UTC(2026, 11, 21, 12)), null);
  assert.equal(isDaylight(svalbardLat, svalbardLon, Date.UTC(2026, 11, 21, 12)), false);
});

test('the southern hemisphere has its seasons the other way round', () => {
  const sydney = { lat: -33.87, lon: 151.21 };
  const june = sunTimes(sydney.lat, sydney.lon, Date.UTC(2026, 5, 21, 2));
  const december = sunTimes(sydney.lat, sydney.lon, Date.UTC(2026, 11, 21, 2));

  const juneHours = (june.sunsetMs - june.sunriseMs) / 3600000;
  const decemberHours = (december.sunsetMs - december.sunriseMs) / 3600000;

  assert.ok(decemberHours > juneHours + 3, `expected December to be much longer, got ${decemberHours} vs ${juneHours}`);
});
