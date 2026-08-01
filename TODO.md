# TODO / later

Things explicitly deferred during development — not forgotten, just not now.
Added to as they come up; picked up in a later stage when relevant.

- **Visual/cosmetic polish** — icon shapes, colors, spacing, general look-and-feel
  pass. Deferred until the app is functionally complete ("na sam koniec",
  said after Stage 1). Icon *shapes* themselves are now done (see the new
  entry below) — this bullet is left open for whatever colors/spacing
  polish is still wanted elsewhere in the UI.
- **New icon set (`public/js/plane-icons.js` + `icon-classify.js`) is now
  wired into the live map** (2026-07-29) — all 16 classified icons + `tower`
  were redesigned this round (extensive render-compare-adjust sessions per
  icon, see git log), and the classification *algorithm*
  (`icon-classify.js`'s decision chain: typeCode 'TWR' -> military-table
  override -> own type table -> ADS-B category -> unknown fallback) is
  final and now live:
  - **Wiring (done)**: `public/js/app.js` now imports icon rendering from
    a new `public/js/aircraft-icon-live.js` adapter (same
    `createPlaneElement`/`setPlaneHeading`/`setPlaneColor`/`setPlaneKind`/
    `setPlaneLabel` call shape the old module had, so `app.js`'s call sites
    barely changed) instead of the OLD `aircraft-icon.js` (4 shapes:
    passenger/light/helicopter/tower; that module, its test file, and
    `/dev/icons`' old-vs-new comparison row were all removed entirely on
    2026-07-30, once nothing referenced them anymore).
    `icon-types.json` is loaded once
    (`await loadIconTypes()`) inside `map.on('load', ...)`, before the
    first queued snapshot is ever classified. `NON_ROTATING_ICON_IDS`
    (balloon/tower/drone never rotate by track) is wired into the new
    `setPlaneHeading`. Each marker also gets a per-kind size multiplier
    (`plane-icons.js`'s `ICON_SIZE_MULTIPLIERS`, e.g. a widebody reads
    1.25x, a drone 0.8x) layered on top of the user's own icon-size slider
    -- applied as an inline `--mlpr-plane-size` override per marker
    (`aircraft-icon-live.js`'s `refreshMarkerSize`), refreshed on a kind
    change and whenever the base slider setting changes
    (`app.js`'s `onSettingsChange`).
    Verified in a real browser (this sandbox has no WebGL, so the actual
    map can't render here -- see the note further down about that) via a
    standalone DOM harness exercising `aircraft-icon-live.js` directly:
    classification, per-kind size, `NON_ROTATING_ICON_IDS` rotation
    behavior, color/label preservation across a kind change, and the
    settings-driven resize path all confirmed correct.
    **Update (2026-07-30): `SPINNING_ROTOR_ICON_IDS`/`getIconRotorPaths()`
    is now wired into the live map too.** `aircraft-icon-live.js`'s
    `iconSvg()` renders the rotor group(s) (blur disc + blade `<g
    class="mlpr-plane-rotor">`) plus the kind's static path for helicopter/
    drone, instead of `getIconPath()`'s single combined path -- everything
    still lives inside the same outer `<g fill stroke>`, so
    `setPlaneColor`'s `element.querySelector('g')` keeps matching the
    outer one (first `<g>` in document order) unchanged. The actual spin
    (`style.css`'s `.mlpr-plane-rotor` + `@keyframes
    mlpr-plane-rotor-spin`) composes fine with the icon's own heading
    rotation on the parent `<svg>` since CSS transforms on nested elements
    are independent -- a helicopter's blades spin *and* the whole icon
    still turns to face its track. Spin duration is read from
    `SUGGESTED_SPIN_DURATION_S` via an inline custom property per element,
    not hardcoded in the stylesheet, so the two can't drift apart.
    `prefers-reduced-motion: reduce` disables it. Verified with a
    standalone DOM harness (this sandbox has no WebGL) confirming the
    animation is actually applied and the blade transform changes over
    time, not just that markup exists.
  - **Stage 3** (mostly done, 2026-07-29): `data/icon-types.json` expanded
    from Stage 1/2's ~30-entry illustrative sample to 246 entries (216
    exact + 27 prefix + 3 military-only), hand-composed from general
    aviation/ICAO-designator knowledge for realistic Central/Eastern
    European receiver traffic (mainline/regional airliners, common GA/
    bizjet/helicopter types -- helicopter had ZERO entries before this
    pass -- and NATO/Polish military types). Structural coverage is
    genuinely broader now, but ~30 of those entries are explicitly
    lower-confidence designators recalled from memory rather than a
    verified source, listed in the JSON's own new `_needsVerification`
    field and viewable/filterable at `/dev/icon-types` (dev-only page,
    "Needs verification only" checkbox). A structural regression test
    (`public/js/icon-classify.test.js`) checks every table entry resolves
    to a real icon id and every prefix is >=3 chars, plus spot-checks the
    classification chain end-to-end against the real shipped table.
    Closing the remaining `_needsVerification` entries is now an ongoing,
    receiver-driven process rather than a one-time task -- see
    `/dev/icon_verify` below.
  - **Stage 4 (a standalone `tools/` cross-check script): deliberately
    skipped**, per explicit decision 2026-07-29 -- `/dev/icon_verify`
    (below) covers the same need as a live page instead, which is more
    useful day-to-day than an offline script would have been. Revisit only
    if a scripted/CI-friendly version is ever wanted on top of it.
  - **`/dev/icon_verify`** (new, 2026-07-29): unlike every other `/dev/*`
    page, this one is **deliberately available in production** (registered
    outside `server.js`'s NODE_ENV dev-tool gate) since it's only useful
    once a receiver has actually accumulated real traffic. Runs every
    registration `GET /api/stats/registrations` has ever recorded a type
    code for through the real `classifyIconKind()` chain against the real
    shipped `icon-types.json`, in a sortable/filterable table with an icon
    swatch per row, highlighting unresolved (`unknown`) entries -- this is
    Stage 4's real-data cross-check, running against this receiver's own
    traffic instead of guesses (and the reason Stage 4's standalone script
    was skipped above). Can't exercise the military-only override table or
    the ADS-B-category fallback stage (no per-registration military-flag
    or category data in that endpoint) -- documented on the page itself,
    not a bug.
  - Still worth doing eventually: let this receiver run for a while, then
    use `/dev/icon_verify` to find real `unknown`/misclassified entries and
    fold fixes back into `data/icon-types.json` -- this is now the
    practical path to clearing the `_needsVerification` list, replacing
    the originally-planned standalone Stage 4 script.
- **Trigger areas on watch-list entries — circle and rectangle shipped
  2026-08-01, free shape still to do.** A watch-list entry can carry an
  optional `area` (`{kind: 'circle', lat, lon, radiusKm}` or
  `{kind: 'rectangle', lat, lon, widthKm, heightKm}`), matched server-side
  in `rules.js`'s `satisfiesAreaCondition`; drawn in a full-screen map
  editor (`public/js/area-editor.js`) opened from the watch-list form. The
  centre is an **arbitrary point, deliberately not the receiver's home** —
  the driving use case is watching a specific piece of sky that isn't
  overhead (an airfield or approach path some km away). Still to build:
  - **Free shape** — the button already renders in the editor's toolbar,
    disabled. The groundwork is all in place: `watchlist.js`'s
    `AREA_SIZE_FIELDS` and `area-editor.js`'s `HANDLE_SPECS` are both
    per-shape tables, and `geo.js`'s `shapeRing` dispatch means the two map
    layers never learn what shape they're drawing. A polygon is the one
    shape that doesn't fit the existing "centre + size fields" model
    though — it needs a vertex list, so it will need its own
    `normalizeArea` branch rather than another `AREA_SIZE_FIELDS` row, plus
    a point-in-polygon test server-side (ray casting, ~15 lines) instead of
    a bounds check. The interaction is the real cost: vertex dragging,
    click-a-side-to-add-a-vertex and loop closing — the point where
    hand-writing it stops being obviously cheaper than a drawing library,
    so weigh that (and its licence) then rather than assuming either way.
  - A separate **"any aircraft within N km of home"** rule, independent of
    the watch list, was considered and deliberately dropped (2026-08-01):
    trigger areas cover the "watch this region" need, and an entry still
    has to name a type/registration/flight, which is the intended scope.
    Revisit only if "notify me about literally anything nearby" turns out
    to be wanted on its own.
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
- **Smart home integration (MQTT / Home Assistant) -- implemented
  2026-07-29**, see CLAUDE.md's "Smart home / MQTT integration" section for
  the full picture. First-seen, watch-list, and (since 2026-08-01) squawk
  7500/7600/7700 notification events all publish a structured JSON event
  over MQTT (`mlpr/events/first_seen`, `mlpr/events/watchlist`,
  `mlpr/events/squawk`), tested against Home Assistant. Deliberately scoped
  narrower than the original request: only rules that already send a
  notification, not a general "aircraft count within 10 km changed" state
  feed. Still-deferred ideas from the original ask, not built:
  - A general geofence-based trigger ("any aircraft within N km", not just
    watched ones) -- depends on the geofence feature below anyway.
  - Continuous/ambient state feed (aircraft count, messages/sec) rather
    than discrete events -- the original idea was "avoid extra load", and
    the discrete-events version already satisfies that trivially; revisit
    only if a real use case for continuous state (not discrete events)
    shows up.
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
  `aircraft-icon-live.js`/`style.css` comments — hover, the achromatic selection
  glow, the plane label, and map↔list cross-highlight are all built on
  per-marker DOM elements) and switching would mean rebuilding all of
  those on symbol-layer mechanics (query rendered features for hover/click,
  a separate layer for the glow, `text-field` for labels). Revisit only if
  real performance problems show up at this receiver's actual traffic
  density — this note is so it's obvious where to look if that happens.
- **Perf/optimization pass found during a 2026-07-29 UI/UX review — done
  2026-08-01**: four small, concrete inefficiencies spotted while reading
  the frontend code (the one already done at the time, merging the three
  hourly prune timers into one, is not in this list):
  - `renderTrail()` in `trailMode: 'all'` (`public/js/app.js`) used to
    rebuild the *entire* trail GeoJSON source once per aircraft inside
    `applyAircraftUpdate`'s per-aircraft loop rather than once after the
    loop — same shape of bug `notifyAircraftChanged()` was already batched
    to fix elsewhere. `applyAircraftUpdate` now returns whether it touched
    the trail, and `handleSnapshot` calls `renderTrail()` at most once per
    snapshot regardless of batch size.
  - Stats' doughnut/line chart-view toggle (`public/js/stats.js`'s
    `drawTopChart`) re-fetched `/api/stats/types`/`/api/stats/airlines`
    from scratch on every toggle click even when the range hadn't changed.
    Added `topChartCountsCache` keyed by `(kind, range)`; the toggle click
    handler now passes `forceRefresh: false` to reuse it, while the range
    selector and the periodic refresh timer still force a fresh fetch.
  - List's sort comparator (`public/js/list.js`'s `visibleAircraft`) called
    `field.sortValue()` fresh on every pairwise comparison during
    `Array.prototype.sort()` — notably wasteful for the `distance` field's
    Haversine calculation. Switched to a decorate-sort-undecorate
    (Schwartzian) transform: each row's sort key(s) are computed once
    upfront.
  - `getLiveAircraft()` (`radar-state.js`) allocates a fresh array on every
    call; `list.js`'s `drawTable()` was calling it twice per render (total
    count, then again inside `visibleAircraft`). Now fetched once and
    reused for both.
