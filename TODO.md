# TODO / later

Things explicitly deferred during development — not forgotten, just not now.
Added to as they come up; picked up in a later stage when relevant.

- **Visual/cosmetic polish** — icon shapes, colors, spacing, general look-and-feel
  pass. Deferred until the app is functionally complete ("na sam koniec",
  said after Stage 1).
- **Notification engine: radius-from-home geofence** — notify when *any*
  aircraft (not just a watched one) enters a distance-from-home radius. The
  watch-list's per-entry altitude condition (below/above threshold) shipped;
  this general geofence rule, independent of the watch list, did not.
- **"First time seen" notification can fire before flight/altitude are
  decoded** — it triggers on the very first poll tick a hex is seen at all,
  which can be before readsb has decoded the callsign/position from the
  broadcast (unlike registration/type, which come from a one-shot local
  --db-file lookup and are either there from message one or never). Seen in
  practice as notifications like "c48e893" or "4892c6 · 484 kt" with fields
  missing. Idea: delay the first-seen notification slightly (a poll tick or
  two) to have a better chance of catching a more complete record. User said
  to add it here and revisit later, not now (2026-07-27).
- **Log unmatched 3-letter airline callsign prefixes** — when
  `airline-lookup.js` sees a well-formed airline-style callsign whose prefix
  isn't in the OpenFlights `airlines.dat` map (`kind: 'airline_unknown'`),
  it's silently ignored rather than logged anywhere. Explicitly called out
  by the user as optional/nice-to-have, not required, when the advanced
  stats feature was specced (2026-07-27) — not implemented.
