import { getAllSeenFlights, upsertSeenFlights } from './db.js';
import { createSeenTracker } from './seen-tracker.js';

// This table exists purely to answer "how many distinct callsigns has this
// receiver seen, and were any of them active in a given window" -- no
// per-key gate, so noteSeen (create-or-touch) covers every call site.
const tracker = createSeenTracker({
  getAllRows: getAllSeenFlights,
  upsertRows: upsertSeenFlights,
  keyField: 'flight',
});

// Called every poll tick for every currently-tracked aircraft with a
// callsign (index.js's recordRangeAndRegistrationSightings) -- creates the
// entry on first-ever sighting, otherwise just advances last_seen_at.
export const noteFlightSeen = tracker.noteSeen;
export const flushDirtySeenFlights = tracker.flush;
export const getSeenFlightsCount = tracker.getCount;
export const resetSeenFlightsCache = tracker.reset;
