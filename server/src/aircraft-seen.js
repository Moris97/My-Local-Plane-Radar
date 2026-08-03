import { getAllAircraftSeenRaw, upsertAircraftSeenRaw } from './db.js';
import { createSeenTracker } from './seen-tracker.js';

// "Aircraft seen" -- every hex the receiver ever gets even a single message
// from, no confirmation gate. Deliberately separate from aircraft-tracked.js
// (which requires ~3s / a second look before counting a hex at all): this
// tracker exists specifically to show the raw, unfiltered number alongside
// the confirmed one, so a user can see both "how many aircraft did the
// antenna glimpse at all" and "how many of those were solid contacts", each
// under its own honest name, instead of one tile trying to answer both
// questions.
const tracker = createSeenTracker({
  getAllRows: getAllAircraftSeenRaw,
  upsertRows: upsertAircraftSeenRaw,
  keyField: 'hex',
});

// Called every poll tick for every currently-tracked aircraft (index.js's
// recordRangeAndRegistrationSightings) -- creates on first sight, otherwise
// just advances last_seen_at.
export const noteAircraftSeen = tracker.noteSeen;
export const flushDirtyAircraftSeen = tracker.flush;
export const getAircraftSeenCount = tracker.getCount;
export const resetAircraftSeenCache = tracker.reset;
