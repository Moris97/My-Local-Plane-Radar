import { getConfig, setConfig, deleteConfig } from '../db.js';
import { hasSeenAircraft, markAircraftSeen } from '../aircraft-tracked.js';
import { getNotificationSettings, getNtfyTopic } from './settings.js';
import { isOnCooldown, markNotified } from './cooldown.js';
import { sendNtfyNotification } from './ntfy.js';
import { getWatchList } from './watchlist.js';
import { publishSmartHomeEvent } from './smart-home.js';
import { distanceKm, destinationPoint } from '../range.js';

// Exported as a function rather than the raw table so the "unknown code"
// fallback lives in one place -- /dev/smart-home-test needs the same
// meaning the real rule would send, and duplicating three strings into a
// dev page would be three strings free to drift.
export function squawkMeaningFor(squawk) {
  return SQUAWK_MEANINGS[squawk] ?? 'Alert';
}

const SQUAWK_MEANINGS = {
  7500: 'Hijack',
  7600: 'Radio failure',
  7700: 'Emergency',
};

const ALL_TIME_MAX_RANGE_KEY = 'allTimeMaxRangeKm';

// readsb can take a poll tick or two to decode an aircraft's callsign and
// position after first hearing its Mode-S address -- firing "first time
// seen" on the very first tick produced notifications like "c48e893" or
// "4892c6 · 484 kt" with fields still missing (reported live, 2026-07-27;
// TODO.md tracked this as deferred until now). hex -> ms epoch of the first
// tick this hex was noticed but not yet notified/recorded -- in-memory
// only, same as cooldown.js's lastNotifiedAt (hard rule 6: fine to lose on
// restart, a still-pending hex just gets treated as new again). A hex that
// never gets a second look within the delay (a one-off Mode-S blip) simply
// never resolves -- no notification, and never written to seen_aircraft
// either, which is arguably more correct than the old immediate-fire
// behavior: we never actually got a good look at it.
const FIRST_SEEN_DELAY_MS = 3000; // a few POLL_INTERVAL_MS (1000ms) ticks
const pendingFirstSeen = new Map();

let notifySender = sendNtfyNotification;

export function setNotifySender(fn) {
  notifySender = fn;
}

function notify(payload) {
  return notifySender(getNtfyTopic(), payload);
}

const WATCH_FIELD_BY_MATCH_TYPE = {
  type: 'typeCode',
  registration: 'registration',
  flight: 'flight',
};

function satisfiesAltitudeCondition(aircraft, entry) {
  if (!entry.altitudeOperator) return true;

  const altitude = aircraft.onGround ? 0 : aircraft.altBaro;
  if (typeof altitude !== 'number') return false;

  if (entry.altitudeOperator === 'below') return altitude < entry.altitudeValue;
  if (entry.altitudeOperator === 'above') return altitude > entry.altitudeValue;
  return true;
}

// Standard ray-casting (even-odd) point-in-polygon test: count how many
// edges a ray cast east from the point crosses; odd means inside. Treating
// lat/lon as plain planar coordinates is right here rather than a
// simplification to apologise for -- it's exactly what the editor draws,
// since a polygon's edges render as straight lines between vertices in Web
// Mercator, so "inside the shape on screen" and "matches" agree by
// construction. (The rectangle's bounds check relies on the same property.)
//
// Even-odd also gives a defined, stable answer for a self-intersecting
// polygon, which the editor allows the user to create by dragging one
// vertex across another -- the enclosed lobes simply alternate. Rejecting
// such shapes outright would be more surprising than honouring them.
function isInsidePolygon(lat, lon, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
    const { lat: latI, lon: lonI } = points[i];
    const { lat: latJ, lon: lonJ } = points[j];
    // Does this edge straddle the point's latitude, and if so, is the
    // crossing east of the point?
    const straddles = latI > lat !== latJ > lat;
    if (!straddles) continue;
    const lonAtLat = lonI + ((lat - latI) / (latJ - latI)) * (lonJ - lonI);
    if (lon < lonAtLat) inside = !inside;
  }
  return inside;
}

// Optional per-entry trigger area (watchlist.js's `area`) -- "only notify
// when this aircraft is actually inside this region". The centre is an
// arbitrary point, not necessarily the receiver's own location: the point
// is watching a specific piece of sky (an airfield, an approach path) that
// may be well away from home.
//
// Same "missing data never produces a false positive" rule the altitude
// condition already follows: an aircraft with no position at all (a
// Mode-S-only contact) simply doesn't match an area-restricted entry,
// rather than being let through on the grounds that we can't prove it's
// outside.
function satisfiesAreaCondition(aircraft, entry) {
  if (!entry.area) return true;
  if (typeof aircraft.lat !== 'number' || typeof aircraft.lon !== 'number') return false;

  if (entry.area.kind === 'circle') {
    return distanceKm(entry.area.lat, entry.area.lon, aircraft.lat, aircraft.lon) <= entry.area.radiusKm;
  }

  if (entry.area.kind === 'rectangle') {
    // Bounds derived with the same destinationPoint() calls the editor uses
    // to draw the box, so "inside the shape on screen" and "matches" can't
    // drift apart. A lat/lon-aligned box is also a true rectangle in Web
    // Mercator (constant latitude is horizontal, constant longitude is
    // vertical), so what's drawn from these four numbers is exactly what's
    // tested here.
    const { lat, lon, widthKm, heightKm } = entry.area;
    const north = destinationPoint(lat, lon, 0, heightKm / 2).lat;
    const south = destinationPoint(lat, lon, 180, heightKm / 2).lat;
    const east = destinationPoint(lat, lon, 90, widthKm / 2).lon;
    const west = destinationPoint(lat, lon, 270, widthKm / 2).lon;

    if (aircraft.lat < south || aircraft.lat > north) return false;
    // A box wide enough to straddle the antimeridian comes back with
    // west > east, where "between" means the two outer arcs, not the inner
    // one. Vanishingly unlikely for a home receiver, but getting it wrong
    // would silently invert the longitude test rather than fail loudly.
    return west <= east
      ? aircraft.lon >= west && aircraft.lon <= east
      : aircraft.lon >= west || aircraft.lon <= east;
  }

  if (entry.area.kind === 'polygon') {
    return isInsidePolygon(aircraft.lat, aircraft.lon, entry.area.points);
  }

  // An unknown shape (e.g. an entry written by a newer version, then
  // downgraded) is treated as "don't match" rather than "match everything"
  // -- a silently over-firing notification rule is worse than a silent one.
  return false;
}

function matchesWatchEntry(aircraft, entry) {
  const field = aircraft[WATCH_FIELD_BY_MATCH_TYPE[entry.matchType]];
  if (!field || field.toLowerCase() !== entry.matchValue.toLowerCase()) return false;
  return satisfiesAltitudeCondition(aircraft, entry) && satisfiesAreaCondition(aircraft, entry);
}

function formatAltitude(aircraft) {
  if (aircraft.onGround) return 'ground';
  return typeof aircraft.altBaro === 'number' ? `${aircraft.altBaro} ft` : null;
}

function formatSpeed(aircraft) {
  return typeof aircraft.gs === 'number' ? `${Math.round(aircraft.gs)} kt` : null;
}

// The notification's title already carries the reason (squawk code, "First
// time seen", "Watched aircraft") -- this is just the aircraft identity +
// current altitude/speed, so registration/type/flight/altitude/speed are
// always present when available.
function aircraftLabel(aircraft) {
  const parts = [aircraft.flight || aircraft.hex];
  if (aircraft.registration) parts.push(aircraft.registration);
  if (aircraft.typeCode) parts.push(aircraft.typeCode);
  const altitude = formatAltitude(aircraft);
  if (altitude) parts.push(altitude);
  const speed = formatSpeed(aircraft);
  if (speed) parts.push(speed);
  return parts.join(' · ');
}

// `now` is injectable (defaults to the real clock) purely so tests can
// exercise FIRST_SEEN_DELAY_MS deterministically without real waits or
// fake timers -- index.js's only call site never passes it.
export function evaluateAircraftRules(aircraft, now = Date.now()) {
  const settings = getNotificationSettings();

  if (settings.squawkEnabled && aircraft.squawk && settings.squawkCodes[aircraft.squawk]) {
    if (!isOnCooldown('squawk', aircraft.hex)) {
      markNotified('squawk', aircraft.hex);
      const squawkMeaning = squawkMeaningFor(aircraft.squawk);
      notify({
        title: `Squawk ${aircraft.squawk} — ${squawkMeaning}`,
        message: aircraftLabel(aircraft),
        priority: 5,
        tags: ['rotating_light'],
      });
      // Smart-home (MQTT): originally scoped to only first-seen/watchlist
      // (see those two call sites below); squawk emergencies were the one
      // explicitly-deferred case from that decision (TODO.md) -- added
      // 2026-08-01, same one-more-call-site change anticipated there.
      publishSmartHomeEvent({ reason: 'squawk', aircraft, squawkMeaning });
    }
  }

  if (!hasSeenAircraft(aircraft.hex)) {
    const firstNoticedAt = pendingFirstSeen.get(aircraft.hex);
    if (firstNoticedAt === undefined) {
      pendingFirstSeen.set(aircraft.hex, now);
    } else if (now - firstNoticedAt >= FIRST_SEEN_DELAY_MS) {
      pendingFirstSeen.delete(aircraft.hex);
      markAircraftSeen(aircraft.hex);
      if (settings.firstSeenEnabled) {
        notify({
          title: 'First time seen',
          message: aircraftLabel(aircraft),
          priority: 3,
          tags: ['eye'],
        });
        // Smart-home (MQTT) is a separate, independent delivery channel --
        // wired to first-seen, watchlist, and squawk (see that block
        // above); range-record is still deliberately out of scope. No-ops
        // on its own if smart-home isn't enabled/configured.
        publishSmartHomeEvent({ reason: 'first_seen', aircraft });
      }
    }
  }

  if (settings.watchedEnabled && !isOnCooldown('watched', aircraft.hex)) {
    const matchedEntry = getWatchList().find((entry) => matchesWatchEntry(aircraft, entry));
    if (matchedEntry) {
      markNotified('watched', aircraft.hex);
      notify({
        title: 'Watched aircraft',
        message: aircraftLabel(aircraft),
        priority: 4,
        tags: ['eyes'],
      });
      publishSmartHomeEvent({ reason: 'watchlist', aircraft, matchedEntry });
    }
  }
}

// Evicts pending hexes that never resolved within maxAgeMs (a one-off
// Mode-S blip that was never heard again) -- otherwise pendingFirstSeen
// would grow unbounded over an install's lifetime. Mirrors cooldown.js's
// pruneCooldowns; called on the same hourly interval from index.js.
export function prunePendingFirstSeen(maxAgeMs = 10 * 60 * 1000) {
  const now = Date.now();
  for (const [hex, at] of pendingFirstSeen) {
    if (now - at > maxAgeMs) pendingFirstSeen.delete(hex);
  }
}

// Reads the same all-time record evaluateRangeRecordRule below maintains --
// used by Stats' "Od początku" section, which wants a single all-time max
// range number without reimplementing this tracking a second time.
export function getAllTimeMaxRangeKm() {
  return Number(getConfig(ALL_TIME_MAX_RANGE_KEY) ?? 0);
}

// The all-time record is a distance from the home location it was measured
// against, so it is cleared alongside the antenna coverage cells when the
// receiver moves -- otherwise a record set from the old position can never
// be beaten from the new one, and the "new range record" notification goes
// permanently silent.
export function resetAllTimeMaxRangeKm() {
  deleteConfig(ALL_TIME_MAX_RANGE_KEY);
}

// A completely different kind of rule from everything above: those all fire
// on the *presence* of some condition on an aircraft; this fires on the
// *absence* of any aircraft at all, i.e. it's a receiver health check, not
// an aircraft-tracking one. "Activity" deliberately means "at least one
// tracked hex, position or not" -- a Mode-S-only contact with no ADS-B
// position still proves the receiver and readsb are both alive, so counting
// only aircraft-with-position would produce false alarms in weak-MLAT areas
// and miss the point besides (a dead antenna produces zero hexes of any
// kind, not just zero positioned ones).
//
// 1 hour, not the originally-floated 5 minutes: requested explicitly
// (2026-08-02) after pointing out that 5 minutes is well within normal
// quiet-hours traffic gaps for a receiver in a low-traffic area, especially
// overnight -- a real false-alarm risk, not a hypothetical one. An hour is
// long enough that most installs would see at least one contact (even a
// distant airliner) in that window if the receiver were actually working.
const RECEIVER_SILENCE_MS = 60 * 60 * 1000;
// In-memory only, same "fine to lose on restart" reasoning as
// pendingFirstSeen/cooldown.js above (hard rule 6) -- a restart just resets
// the countdown, which reads as "the receiver just came back", a reasonable
// thing to believe immediately after a restart anyway. Seeded to the
// process's own start time (not 0/never) so a fresh boot doesn't count the
// time since the Unix epoch as an unbroken silence and fire on its very
// first unlucky poll.
let lastActivityAt = Date.now();
// Latches once fired so a silence spanning many poll ticks only ever
// notifies once, not once per tick for the rest of the outage; cleared the
// moment activity resumes so the *next* outage can notify again.
let receiverSilenceNotified = false;

// Test-only reset, same shape as cooldown.js's resetCooldowns -- lets each
// test start from "just came online" instead of carrying over whatever the
// previous test's clock left behind.
export function resetReceiverSilenceState(now = Date.now()) {
  lastActivityAt = now;
  receiverSilenceNotified = false;
}

// `hasActivity` is the caller's job to define (index.js): true whenever the
// most recent poll tick produced at least one tracked aircraft, false for
// an empty snapshot **or** a poll that failed outright (source.fetchSnapshot
// returning null) -- a source that can't even be read is at least as
// concerning as one that reads but finds nothing.
export function evaluateReceiverSilenceRule(hasActivity, now = Date.now()) {
  if (hasActivity) {
    lastActivityAt = now;
    receiverSilenceNotified = false;
    return;
  }

  if (receiverSilenceNotified) return;
  if (now - lastActivityAt < RECEIVER_SILENCE_MS) return;

  // Latched regardless of the enabled setting below, not just when it
  // actually sends -- otherwise toggling the setting off and back on
  // mid-outage would re-fire immediately, and a disabled rule shouldn't be
  // doing per-tick work indefinitely once it already knows the answer.
  receiverSilenceNotified = true;

  const settings = getNotificationSettings();
  if (!settings.receiverSilenceEnabled) return;

  const hours = Math.round(RECEIVER_SILENCE_MS / 3600000);
  notify({
    title: 'Receiver silent',
    message: `No aircraft seen (not even without a position) for over ${hours}h — check readsb/SDR`,
    priority: 4,
    tags: ['warning'],
  });
}

export function evaluateRangeRecordRule(maxRangeKm) {
  if (typeof maxRangeKm !== 'number') return;

  const settings = getNotificationSettings();
  const record = Number(getConfig(ALL_TIME_MAX_RANGE_KEY) ?? 0);
  if (maxRangeKm <= record) return;

  setConfig(ALL_TIME_MAX_RANGE_KEY, String(maxRangeKm));
  if (settings.rangeRecordEnabled) {
    notify({
      title: 'New range record',
      message: `${maxRangeKm.toFixed(0)} km (previous: ${record.toFixed(0)} km)`,
      priority: 4,
      tags: ['dash'],
    });
  }
}
