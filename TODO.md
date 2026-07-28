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
- **Circling-aircraft notification** (effort: medium, impact: high,
  priority: low) — an aircraft that loops in roughly the same place for
  several minutes is usually doing something worth knowing about: police,
  air ambulance, a survey flight, a patrol, a search-and-rescue operation.
  Simple detection: cumulative heading change past 360° while the trail's
  centroid barely moves. Catches events that would otherwise go unnoticed.
  Requested 2026-07-28.
- **Overhead-proximity alert** (effort: small, impact: high, priority: low)
  — a distinct notification category from the existing watch list: any
  aircraft within e.g. 2 km of the receiver, with an ETA computed from its
  current course/speed ("overhead in 40s — Boeing 737, 3200 ft"), giving
  enough warning to actually step outside and look. Could also report
  elevation angle and azimuth (where to look). Requested 2026-07-28.
- **Altitude/speed-over-time chart in the aircraft details panel** (effort:
  small, impact: medium, priority: low) — a small time-series chart for the
  selected/inspected aircraft showing climb/cruise/step-down descent.
  Plotted against `nav_altitude_mcp`, it would show the altitude the pilot
  dialed into the autopilot before the aircraft actually got there.
  Requested 2026-07-28.
- **Unusual-event detector** (effort: medium, impact: medium, priority: low)
  — rules flagging: a go-around (a descent immediately followed by a climb
  near an airport), a holding pattern, a vertical-rate spike above
  3000 ft/min, squawk changing to 7700 mid-flight, SPI pressed by the
  pilot, and GPS loss. The last one would need `gpsOkBefore`, which
  CLAUDE.md's aircraft.json contract already flags as one of readsb's own
  experimental/undocumented fields (deliberately not read anywhere in this
  codebase) — re-verify against readsb's current docs before building
  anything on it, don't assume it's still safe to use. Requested 2026-07-28.
- **Wallboard mode** (effort: small, impact: medium, priority: low) — a
  fullscreen view for an old monitor or a wall-mounted tablet: map, a
  handful of key numbers, no controls, automatic rotation between the map
  and Stats. Since the UI is already responsive, mostly a matter of an
  additional stylesheet and a URL parameter to select it. Requested
  2026-07-28.
- **Receiver health monitoring** (effort: small, impact: medium, priority:
  low) — an RSSI-vs-distance chart, detecting amplifier overload (a rising
  count of `strong_signals`), monitoring `blocks_dropped` from `stats.json`
  as a Pi-overload warning, and a messages-per-second-over-24h chart. Plus
  a "receiver has been silent for 5 minutes" ntfy alert, so a crashed
  readsb/SDR doesn't go unnoticed until someone happens to check the app.
  Requested 2026-07-28.
- **Smart home integration (MQTT / Home Assistant)** — a lightweight
  MQTT client publishing receiver state and flight stats to a home
  automation system, only on meaningful state changes (e.g. the aircraft
  count within 10 km changes, a specific type is detected) rather than
  continuously, to avoid extra load on the Pi. Example automations: an
  announcement or light flash when an interesting aircraft passes overhead,
  an LED strip turning red on squawk 7700, a daily aircraft count on an
  e-paper display, muting music/TV when a helicopter passes low overhead.
  Requested 2026-07-28.
- **PTZ camera tracking ("Cam-Track")** — given the receiver's own GPS
  position and an aircraft's lat/lon/altitude, compute azimuth and
  elevation angle and drive a PTZ IP camera to point at it (most support
  ONVIF or simple HTTP CGI commands), updated every 1-2s. A visual "wow
  effect" feature. Requested 2026-07-28.
- **DOM `maplibregl.Marker`-per-aircraft has a performance ceiling** —
  fine at this project's realistic scale, but a few hundred simultaneous
  aircraft is where large ADS-B web UIs typically move to a MapLibre
  symbol layer (one GeoJSON source, `icon-image`/`icon-size`/`icon-rotate`,
  GPU-composited) instead of one HTML element per aircraft. Explicitly
  *not* being done now (2026-07-28, during the icon-set/classification
  work): the current DOM-marker architecture is deliberate (see
  `aircraft-icon.js`/`style.css` comments — hover, the achromatic selection
  glow, the plane label, and map↔list cross-highlight are all built on
  per-marker DOM elements) and switching would mean rebuilding all of
  those on symbol-layer mechanics (query rendered features for hover/click,
  a separate layer for the glow, `text-field` for labels). Revisit only if
  real performance problems show up at this receiver's actual traffic
  density — this note is so it's obvious where to look if that happens.
- **Perf/optimization pass found during a 2026-07-29 UI/UX review** — small,
  concrete inefficiencies spotted while reading the frontend code, not yet
  fixed (the one already done, merging the three hourly prune timers into
  one, is not in this list):
  - `renderTrail()` in `trailMode: 'all'` (`public/js/app.js`, called from
    inside `applyAircraftUpdate`'s per-aircraft loop in `handleSnapshot`)
    rebuilds the *entire* trail GeoJSON source — every tracked aircraft,
    every point, re-run through the MLAT filter/smoothing pass — once per
    aircraft in the incoming batch, instead of once after the loop. Exactly
    the same shape of bug `notifyAircraftChanged()` was already batched to
    fix elsewhere (see `radar-state.js`'s comment on `noteAircraft`) — this
    one spot never got the equivalent fix. A batch of 20 updated aircraft
    means the full trail source is rebuilt 20 times instead of once.
  - Stats' doughnut/line chart-view toggle (`public/js/stats.js`'s
    `drawTopChart`) re-fetches `/api/stats/types` or `/api/stats/airlines`
    from scratch on every toggle click, even when the range hasn't changed
    and the same data was just fetched for the other view. Worth caching
    per (kind, range), invalidated on an actual range change.
  - List's sort comparator (`public/js/list.js`'s `visibleAircraft`) calls
    `field.sortValue(a, ctx)`/`(b, ctx)` fresh on every pairwise comparison
    during `Array.prototype.sort()` instead of computing each row's sort
    key(s) once upfront (a decorate-sort-undecorate / Schwartzian
    transform). Notably wasteful for the `distance` field, which redoes a
    Haversine calculation per comparison rather than once per aircraft.
  - `getLiveAircraft()` (`radar-state.js`) allocates a fresh array via
    `Array.from(liveAircraft.values())` on every call; `list.js`'s
    `drawTable()` calls it twice per render (once for the total count via
    `.length`, once more inside `visibleAircraft` for the filtered/sorted
    rows). Trivial to halve: fetch once, reuse for both.
