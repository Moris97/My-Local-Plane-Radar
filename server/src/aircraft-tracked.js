import { getAllSeenAircraft, upsertSeenAircraft } from './db.js';
import { createSeenTracker } from './seen-tracker.js';

// "Aircraft tracked" -- a hex only lands here once the first-seen
// notification's own delay (notifications/rules.js's pendingFirstSeen, ~3s
// / a second look) confirms it as a real, stable contact, not a one-off
// Mode-S blip. See aircraft-seen.js for the raw, unfiltered counterpart
// this deliberately does *not* replace.
const tracker = createSeenTracker({
  getAllRows: getAllSeenAircraft,
  upsertRows: upsertSeenAircraft,
  keyField: 'hex',
});

// hasSeenAircraft/markAircraftSeen keep their original names (moved here
// from db.js unchanged in meaning) since notifications/rules.js's
// first-seen logic is still the only thing allowed to *create* an entry --
// creation stays gated by its own delay, this module just adds the ability
// to track last_seen_at for whatever it already confirmed.
export const hasSeenAircraft = tracker.has;
export const markAircraftSeen = tracker.create;

// Called every poll tick for every currently-tracked aircraft (index.js's
// recordRangeAndRegistrationSightings) -- a no-op for any hex that hasn't
// been confirmed yet, otherwise advances last_seen_at.
export const touchAircraftTracked = tracker.touch;
export const flushDirtyAircraftTracked = tracker.flush;
export const getAircraftTrackedCount = tracker.getCount;
export const resetAircraftTrackedCache = tracker.reset;
