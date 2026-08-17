import { getConfig, setConfig, deleteConfig } from '../db.js';
import { hasSeenAircraft, markAircraftSeen } from '../aircraft-tracked.js';
import { getNotificationSettings, getNtfyTopic } from './settings.js';
import { isOnCooldown, markNotified } from './cooldown.js';
import { sendNtfyNotification } from './ntfy.js';
import { getWatchList } from './watchlist.js';
import { publishSmartHomeEvent, aircraftFields } from './smart-home.js';
import { distanceKm, bearingDegrees, destinationPoint, closestApproach, roundKm } from '../range.js';
import { getEffectiveHome } from '../home.js';
import { recordAndCheckCircling, isCirclingRelevant } from './circling-detector.js';

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

// A FOURTH, independent delivery channel alongside ntfy/MQTT/(future)
// history: pushes the exact same "something just fired" fact to any
// connected browser tab over the existing WebSocket, for the on-map toast/
// glow feature. Same injectable-dependency shape as setNotifySender above
// (default no-op -- rules.js itself has no idea what a WebSocket is; the
// real sender is server.js's `broadcast`, wired in from index.js's main()
// once buildServer() returns it). A no-op default also means every existing
// test in this file that never calls setUiEventSender is unaffected.
let uiEventSender = () => {};

export function setUiEventSender(fn) {
  uiEventSender = fn;
}

// `kind` doubles as the discriminant the client switches on to build the
// right toast text/icon, and as the notification-settings key prefix
// (`${kind}Enabled`) at each call site below -- so a UI event can only ever
// be emitted for a rule the user has actually turned on, exactly the same
// gate ntfy's own notify() already sits behind at every call site. Deliberately
// self-contained (no lat/lon, no live aircraft reference) via
// smart-home.js's aircraftFields() -- same reasoning as that module's own
// payload: the browser already has this aircraft's live position from the
// ordinary WS delta stream, and a toast never needs to draw anything new on
// the map, only select something already there.
function emitUiEvent(kind, detail) {
  uiEventSender({ kind, now: Date.now() / 1000, ...detail });
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

const FT_TO_KM = 0.0003048;

// Angle above the horizon to look, from the receiver's own position --
// altBaro is barometric altitude above sea level, not height above the
// receiver specifically, same approximation this codebase already makes
// everywhere else altitude is used (the altitude filter, colorForAltitude,
// etc.) rather than something new invented for this rule. null (not 0) when
// there's nothing to compute from, so the caller can tell "no data" apart
// from "level with the horizon".
function elevationDegrees(aircraft, distanceKmValue) {
  const altitudeFt = aircraft.onGround ? 0 : aircraft.altBaro;
  if (typeof altitudeFt !== 'number') return null;
  // atan2, not atan(alt/dist), specifically so a near-zero horizontal
  // distance (an aircraft essentially straight overhead) still resolves to
  // ~90° instead of a division blowing up.
  return (Math.atan2(altitudeFt * FT_TO_KM, distanceKmValue) * 180) / Math.PI;
}

// The same {distanceKm, azimuthDeg, elevationDeg, etaSeconds, cpaDistanceKm}
// shape both evaluateAircraftRules below and /dev/smart-home-test's
// send-test-event route need (server.js) -- exported so the dev page's test
// event carries genuinely-computed numbers instead of the client inventing
// its own, same reasoning as squawkMeaningFor being derived server-side
// rather than sent from the form.
export function buildOverheadInfo(home, aircraft) {
  const distanceKmValue = distanceKm(home.lat, home.lon, aircraft.lat, aircraft.lon);
  const azimuthDeg = bearingDegrees(home.lat, home.lon, aircraft.lat, aircraft.lon);
  const elevationDeg = elevationDegrees(aircraft, distanceKmValue);
  const closest = closestApproach(home.lat, home.lon, aircraft.lat, aircraft.lon, aircraft.track, aircraft.gs);
  return {
    distanceKm: roundKm(distanceKmValue),
    azimuthDeg: Math.round(azimuthDeg),
    elevationDeg: elevationDeg === null ? null : Math.round(elevationDeg),
    etaSeconds: closest ? Math.round(closest.etaSeconds) : null,
    cpaDistanceKm: closest ? roundKm(closest.cpaDistanceKm) : null,
  };
}

// Azimuth (where to look) and, when the aircraft's course/speed say
// something useful, an ETA to its closest approach -- appended after
// aircraftLabel's own identity/altitude/speed rather than replacing any of
// it, same " · " join style throughout this file. "closest in Ns" is
// omitted whenever buildOverheadInfo found nothing to report (no track/
// speed, stationary, or already receding) rather than shown as a stale/
// negative number -- see closestApproach's own doc comment (range.js) for
// exactly which cases that covers.
function overheadDetail(aircraft, overheadInfo) {
  const parts = [aircraftLabel(aircraft), `${overheadInfo.azimuthDeg}° az`];
  if (overheadInfo.elevationDeg !== null) parts.push(`${overheadInfo.elevationDeg}° elev`);
  if (overheadInfo.etaSeconds !== null) parts.push(`closest in ${overheadInfo.etaSeconds}s`);
  return parts.join(' · ');
}

// `now` is injectable (defaults to the real clock) purely so tests can
// exercise FIRST_SEEN_DELAY_MS deterministically without real waits or
// fake timers -- index.js's only call site never passes it.
// Returns the set of alert kinds -- currently just 'squawk'/'watched' --
// that are TRUE for this aircraft right now, independent of cooldown. This
// is what drives the on-map red glow (app.js): unlike a notification, which
// is deliberately a one-shot event throttled by cooldown.js, the glow is a
// live, continuously-reappraised fact ("is this aircraft still squawking an
// emergency code / still inside its watched area right now") and must be
// free to turn itself off the instant the underlying condition does --
// gating it by the same cooldown that throttles the *notification* would
// leave a plane glowing red for up to 30 minutes after its squawk cleared.
// first-seen/range-record/receiver-silence are deliberately NOT included
// here -- each is a one-shot event (an aircraft is only ever "first seen"
// for one tick, a range record is a moment in time), not a standing
// condition an aircraft can currently satisfy, so they get a client-side
// timed glow tied to their own toast's lifetime instead (see app.js).
export function evaluateAircraftRules(aircraft, now = Date.now()) {
  const settings = getNotificationSettings();
  const alertKinds = [];

  if (settings.squawkEnabled && aircraft.squawk && settings.squawkCodes[aircraft.squawk]) {
    alertKinds.push('squawk');
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
      // Fourth channel, see emitUiEvent's own doc comment. squawk is the
      // one alert kind with no separate "should this actually notify"
      // question distinct from "is the condition true" (unlike watchlist
      // below, cooldown is the only gate) -- so this sits right where the
      // ntfy/MQTT sends already are, not up by the alertKinds.push above.
      emitUiEvent('squawk', { hex: aircraft.hex, aircraft: aircraftFields(aircraft), squawk: aircraft.squawk, squawkMeaning });
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
        emitUiEvent('first_seen', { hex: aircraft.hex, aircraft: aircraftFields(aircraft) });
      }
    }
  }

  // Restructured (v2.1.20) so the watch list is always scanned when the
  // rule is on, cooldown or not -- previously the cooldown check short-
  // circuited *before* getWatchList().find(...) ever ran, which was a fine
  // micro-optimisation when all that mattered was "should I notify now" but
  // silently meant "is this aircraft currently watched" had no answer while
  // on cooldown, which the glow above needs an honest answer to on every
  // tick regardless.
  if (settings.watchedEnabled) {
    const matchedEntry = getWatchList().find((entry) => matchesWatchEntry(aircraft, entry));
    if (matchedEntry) {
      alertKinds.push('watched');
      if (!isOnCooldown('watched', aircraft.hex)) {
        markNotified('watched', aircraft.hex);
        notify({
          title: 'Watched aircraft',
          message: aircraftLabel(aircraft),
          priority: 4,
          tags: ['eyes'],
        });
        publishSmartHomeEvent({ reason: 'watchlist', aircraft, matchedEntry });
        emitUiEvent('watchlist', {
          hex: aircraft.hex,
          aircraft: aircraftFields(aircraft),
          matchedType: matchedEntry.matchType,
          matchedValue: matchedEntry.matchValue,
        });
      }
    }
  }

  // Standing condition, same shape as squawk/watchlist above: alertKinds
  // gets the live answer every tick the rule is on, regardless of
  // cooldown, so the map glow tracks the actual ongoing turn rather than
  // freezing for 30 minutes after the first notification -- and, same as
  // squawk/watchlist, gated on the setting for *both* the glow and the
  // notification together, not just the notification: turning the rule
  // off should also turn off the visual distraction, not just the pushes.
  // recordAndCheckCircling only gets fed samples while the rule is on --
  // a disabled rule doing per-tick position/heading bookkeeping for every
  // moving aircraft on the off chance it gets re-enabled later isn't worth
  // the always-on cost on a Pi 3 for a feature nobody asked to keep warm.
  // isCirclingRelevant is checked at the same gate, for the same reason --
  // a light aircraft doing routine circuit training (reported live as the
  // overwhelming majority of what this rule was firing on before this
  // check existed) gets no window built for it at all, not just no
  // notification once one's detected.
  if (
    settings.circlingEnabled &&
    isCirclingRelevant(aircraft) &&
    typeof aircraft.lat === 'number' &&
    typeof aircraft.lon === 'number'
  ) {
    const circling = recordAndCheckCircling(aircraft.hex, aircraft, now);
    if (circling) {
      alertKinds.push('circling');
      if (!isOnCooldown('circling', aircraft.hex)) {
        markNotified('circling', aircraft.hex);
        notify({
          title: 'Aircraft circling',
          message: aircraftLabel(aircraft),
          priority: 3,
          tags: ['repeat'],
        });
        publishSmartHomeEvent({ reason: 'circling', aircraft });
        emitUiEvent('circling', { hex: aircraft.hex, aircraft: aircraftFields(aircraft) });
      }
    }
  }

  // Presence-based like squawk/watchlist above (fires once per cooldown
  // while the condition holds), but the condition is plain distance from
  // home rather than a flagged/watched aircraft -- so this is gated first
  // on the position actually being known (a Mode-S-only contact can't be
  // "nearby" in any sense this rule can measure) and on a home location
  // being configured at all, before paying for a distance calculation.
  if (
    settings.overheadEnabled &&
    typeof aircraft.lat === 'number' &&
    typeof aircraft.lon === 'number' &&
    !isOnCooldown('overhead', aircraft.hex)
  ) {
    const home = getEffectiveHome();
    if (home) {
      const distanceKmValue = distanceKm(home.lat, home.lon, aircraft.lat, aircraft.lon);
      if (distanceKmValue <= settings.overheadRadiusKm) {
        markNotified('overhead', aircraft.hex);
        const overheadInfo = buildOverheadInfo(home, aircraft);
        notify({
          title: 'Nearby aircraft',
          message: overheadDetail(aircraft, overheadInfo),
          priority: 4,
          tags: ['airplane'],
        });
        publishSmartHomeEvent({ reason: 'overhead', aircraft, overheadInfo });
        // Deliberately NOT emitUiEvent('overhead', ...) -- the on-map
        // toast/glow feature (v2.1.20) covers the five rules the user
        // actually asked for (squawk, first-seen, watchlist, range-record,
        // receiver-silence); overhead-proximity was shipped one release
        // earlier and wasn't in that list. Nothing structural stops adding
        // it later -- the kind registry on the client is a plain lookup
        // table -- this is scope, not a limitation.
      }
    }
  }

  return alertKinds;
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

// In-memory cache of the all-time record, read from SQLite at most once
// (lazily, on first use) rather than on every poll tick -- see
// evaluateRangeRecordRule below for why the *write* side of this is also
// deferred rather than hitting SQLite the instant a new record is set.
// null means "not loaded from SQLite yet", distinct from 0 (a genuine,
// loaded record of zero -- a fresh install with no range sample yet).
let cachedRecordKm = null;
let recordDirty = false;

function loadRecordKm() {
  if (cachedRecordKm === null) cachedRecordKm = Number(getConfig(ALL_TIME_MAX_RANGE_KEY) ?? 0);
  return cachedRecordKm;
}

// Reads the same all-time record evaluateRangeRecordRule below maintains --
// used by Stats' "Od początku" section, which wants a single all-time max
// range number without reimplementing this tracking a second time. Reads
// the in-memory cache (always current, even before the next periodic
// flush persists it) rather than SQLite directly.
export function getAllTimeMaxRangeKm() {
  return loadRecordKm();
}

// The all-time record is a distance from the home location it was measured
// against, so it is cleared alongside the antenna coverage cells when the
// receiver moves -- otherwise a record set from the old position can never
// be beaten from the new one, and the "new range record" notification goes
// permanently silent.
export function resetAllTimeMaxRangeKm() {
  deleteConfig(ALL_TIME_MAX_RANGE_KEY);
  cachedRecordKm = 0;
  recordDirty = false;
}

// Forgets the cached record so the next read takes it from SQLite again --
// used after a backup restore has written a different value there.
// Deliberately not resetAllTimeMaxRangeKm() above, which deleteConfig()s
// the key. null (rather than 0) is what means "not loaded yet" to
// loadRecordKm; leaving 0 would make a restored 300 km record look like a
// fresh install with no record at all, and the next sample above 0 would
// overwrite it.
export function invalidateAllTimeMaxRangeKmCache() {
  cachedRecordKm = null;
  recordDirty = false;
}

// Called from the same periodic flush tick as flushDailyStats (and the
// graceful-shutdown path that also calls it) -- see evaluateRangeRecordRule
// for why the write itself is deferred to here instead of happening inline
// on every improved record.
export function flushAllTimeMaxRangeKmIfDirty() {
  if (!recordDirty) return;
  setConfig(ALL_TIME_MAX_RANGE_KEY, String(cachedRecordKm));
  recordDirty = false;
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
  // No hex/aircraft -- this is the one alert kind that isn't about a
  // specific aircraft at all (see app.js's kind registry: no click-to-
  // select, no glow, since there's nothing on the map to point at).
  emitUiEvent('receiver_silence', { hours });
}

// The write side of the all-time record is deferred to
// flushAllTimeMaxRangeKmIfDirty (called from the same periodic flush tick
// as flushDailyStats) rather than hitting SQLite here, inline, every time
// -- this runs from the per-second poll loop (index.js's
// recordRangeAndRegistrationSightings), and a fresh install can beat its
// own record on nearly every tick as new, farther contacts appear, which
// was a real SD-write burst before this. The notification itself still
// fires immediately either way -- only the persistence is batched.
// `aircraft` (optional) is whichever tracked aircraft happened to set the
// new record on this tick (index.js's recordRangeAndRegistrationSightings
// tracks it alongside the bare distance) -- used only for the UI event's
// click-to-select-on-the-map affordance, not for the ntfy message (which
// stays a bare distance, unchanged, since ntfy already has no way to link
// a click back into a specific browser tab's map). `undefined` (no known
// aircraft, e.g. a future caller that only has the number) still records
// and notifies exactly as before, just without a UI event to emit.
export function evaluateRangeRecordRule(maxRangeKm, aircraft) {
  if (typeof maxRangeKm !== 'number') return;

  const settings = getNotificationSettings();
  const record = loadRecordKm();
  if (maxRangeKm <= record) return;

  cachedRecordKm = maxRangeKm;
  recordDirty = true;
  if (settings.rangeRecordEnabled) {
    notify({
      title: 'New range record',
      message: `${maxRangeKm.toFixed(0)} km (previous: ${record.toFixed(0)} km)`,
      priority: 4,
      tags: ['dash'],
    });
    if (aircraft) {
      emitUiEvent('range_record', {
        hex: aircraft.hex,
        aircraft: aircraftFields(aircraft),
        rangeKm: maxRangeKm,
        previousRangeKm: record,
      });
    }
  }
}
