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
- **Log unmatched 3-letter airline callsign prefixes** — when
  `airline-lookup.js` sees a well-formed airline-style callsign whose prefix
  isn't in the OpenFlights `airlines.dat` map (`kind: 'airline_unknown'`),
  it's silently ignored rather than logged anywhere. Explicitly called out
  by the user as optional/nice-to-have, not required, when the advanced
  stats feature was specced (2026-07-27) — not implemented.
- **Smooth MLAT trail positions (priority: low)** — MLAT-derived positions can
  jump, producing jagged zigzags and false sharp turns, especially with weak
  receiver geometry. Needs anomaly detection (rejecting points that would
  require unrealistic speed/turn-rate relative to neighboring samples) and
  path smoothing — for `sourceType === 'mlat'` only, ADS-B positions stay
  untouched. Requested 2026-07-28, not implemented.
