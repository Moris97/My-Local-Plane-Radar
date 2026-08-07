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
- **Trigger areas on watch-list entries — complete as of 2026-08-02.** A
  watch-list entry can carry an optional `area`, and only fires while the
  aircraft is inside it. All three shapes are implemented: `circle`
  (`radiusKm`), `rectangle` (`widthKm`/`heightKm`) and `polygon` (`points`,
  3–60 vertices), matched server-side in `rules.js`'s
  `satisfiesAreaCondition`, drawn in `public/js/area-editor.js`. The centre
  is an **arbitrary point, deliberately not the receiver's home** — the
  driving use case is watching a specific piece of sky that isn't overhead
  (an airfield or approach path some km away). Nothing outstanding here;
  see CLAUDE.md for how the three shapes divide up.


- **Notification/event history (the `events` table CLAUDE.md's architecture
  diagram already promises)** (effort: medium, impact: medium, priority:
  deferred — user wants to think it over) — SQLite today only has `config`,
  `daily_stats`, `seen_aircraft`, `registrations`, and `seen_flights`; there
  is no table actually recording individual notification/event occurrences
  (squawk, first-seen, watch-list match, range record, and now
  receiver-silence), even though the architecture section at the top of
  CLAUDE.md has said "events + daily aggregates only" from the start. Today
  a notification fires over ntfy/MQTT and leaves no trace in the app itself
  — no way to see what fired while you weren't looking, or to sanity-check
  that a rule/trigger area is actually working. One row per event (not per
  position) fits hard rule 4 fine, and the write can batch into the
  existing 45s `daily_stats` flush rather than adding a new SD-writing path.
  Would want a retention cap (e.g. 90 days) and a simple timeline view
  somewhere in the UI. Proposed 2026-08-02.
- ~~**Emergency squawk banner/marker on the live map**~~ **Done, 2026-08-08
  (v2.1.20) — and generalized well past the original ask.** Proposed
  2026-08-02 as squawk-only; when picked up, the user explicitly widened it
  to *every* rule that already sends a push notification (squawk,
  first-seen, watchlist, range-record, receiver-silence), not just the
  emergency case. Shipped as two coordinated pieces: on-map toast
  notifications (`public/js/notifications-ui.js`, a dismissible card stack,
  auto-dismissing after 30s but pausing while the tab is backgrounded, with
  a `(N)` unread badge in the tab title) and a red marker glow reusing the
  existing selection-glow *technique* in a new element/class (persistent
  for squawk/watchlist, tied to the live condition; timed to the toast's
  own 30s for first-seen/range-record) — see CLAUDE.md's Notification
  engine section for the full design. **Not done**: the WebAudio-generated
  tone from the original proposal — still open, see below.
- **Audio alert tone for on-map notifications** (effort: small, impact:
  low, priority: low) — the WebAudio-generated-tone half of the toast
  notification idea above, deliberately left out of the 2026-08-08 build
  (not requested when the toast feature was scoped). No audio file, no
  dependency, consistent with this app's "hand-write it, it's a few dozen
  lines" bias -- would need its own enabled/disabled setting (a home radar
  app making unexpected sounds is exactly the kind of thing that should
  default off or at least be easy to mute) and almost certainly a
  same-tab-only guard (a browser tab left open in the background is a very
  different situation from "recover attention right now").
- **Major airports shown on the offline basemap** (effort: small, impact:
  medium, priority: low) — offline mode's Natural Earth layer
  (`scripts/fetch-mapdata.sh`, coastlines/borders/rivers/major cities) has
  no airports at all; online mode already gets them for free from
  OpenFreeMap's vector tiles (`online-dark.json`'s airports/runways/
  taxiways layers), so this is only a gap in the no-internet path. Scope
  deliberately narrow — **major international airports only**, not a full
  aerodrome/private-strip database (that's what OSM's live vector tiles are
  for in online mode) — fetched once at install time via an **Overpass
  Turbo query** for `aeroway=aerodrome` nodes/ways with both an `icao` tag
  and a size signal (e.g. `iata` present, or filtered by a passenger/
  runway-length threshold), same one-shot-fetch-into-`data/`,
  never-committed pattern as `fetch-mapdata.sh`/`fetch-airlines.mjs`. Comes
  from the 2026-08-02 conversation about whether OSM could stand in for
  OpenFlights' `airports.dat` (routes.dat itself was ruled out separately —
  frozen since 2014, no live route-matching value) — this is the
  practical, scoped-down piece of that idea that's actually worth building:
  a label/dot for the label-free offline map, not a lookup table for
  anything else. Needs a rendering pass matching the existing
  `OFFLINE_PALETTES` light/dark treatment in `basemap.js`. Proposed
  2026-08-02.
- **Circling-aircraft notification** (effort: medium, impact: high,
  priority: low) — an aircraft that loops in roughly the same place for
  several minutes is usually doing something worth knowing about: police,
  air ambulance, a survey flight, a patrol, a search-and-rescue operation.
  Simple detection: cumulative heading change past 360° while the trail's
  centroid barely moves. Catches events that would otherwise go unnoticed.
  Requested 2026-07-28.
- ~~**Overhead-proximity alert**~~ **Done, 2026-08-07 (v2.1.19).** A new
  `overheadEnabled`/`overheadRadiusKm` notification rule
  (`rules.js`'s `evaluateAircraftRules`, `settings.js`) fires once per
  cooldown for any aircraft within the configured radius (default 2 km) of
  the receiver's effective home location, message carrying azimuth,
  elevation (when altitude is known) and an ETA to closest approach (when
  course/speed say something useful) — see CLAUDE.md's Notification engine
  section for the full geometry and default-off reasoning.
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
  count of `strong_signals`), and monitoring `blocks_dropped` from
  `stats.json` as a Pi-overload warning. Requested 2026-07-28. **The "receiver
  has been silent" alert half of this is now implemented, 2026-08-02** — see
  CLAUDE.md's Notification engine section (`evaluateReceiverSilenceRule`).
  Shipped at a 1-hour threshold, not the 5 minutes originally floated here:
  the user pointed out 5 minutes is well within a normal quiet-traffic gap,
  especially overnight in a low-traffic area, and would have been a real
  false-alarm source. What's left of this bullet is just the two charts.
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

## From the 2026-08-02 whole-project review

Twenty items were proposed across UI / UX / performance / other. All five UI
items and the performance group are done (see the git log for 2026-08-02);
two performance items were **dropped after measuring them** rather than
implemented, and are recorded below so nobody re-proposes them without the
numbers. What's left:

### UX

- ~~**No connection-status indicator**~~ **Done, v2.1.14.** A red pill
  (`#mlpr-connection-status`, top-center, `aria-live="polite"`) shown only
  while the WebSocket is actually down — hidden the instant `connect()`'s
  `open` event fires. Done together with the backoff item below, as
  planned.
- ~~**WebSocket reconnect has no backoff**~~ **Done, v2.1.14.** Exponential
  backoff (`INITIAL_RECONNECT_DELAY_MS` 1s, doubling to a
  `MAX_RECONNECT_DELAY_MS` 30s cap), reset back to the start on a successful
  `open`. Feeds the status indicator above.
- **Watch-list entries can't be edited** (effort: medium, impact: medium) —
  only `POST` and `DELETE` exist (`server.js`). Since an entry now carries a
  match type, an optional altitude condition *and* an optional trigger area
  drawn on a map, "delete and re-add" means redrawing the area from scratch.
  Needs a `PUT /api/notifications/watchlist/:id` plus an edit affordance on
  each row, with the editor pre-loaded with the existing area.

### Other

- **No CI** (effort: small, impact: medium) — there is no
  `.github/workflows`. 453 tests exist and pass, but nothing runs them on
  push or PR, so a regression only surfaces when someone happens to run
  `npm test` locally. A single workflow running `npm ci && npm test` on
  Node 22/24 would cover it.
- ~~**`escapeHtml` is duplicated three times**~~ **Done, v2.1.14.** Moved to
  `public/js/html-escape.js`, same spirit as `geo.js`/`debounce.js`/
  `pending-queue.js`; `app.js`/`stats.js`/`aircraft-panel.js` all import it
  now instead of each defining their own copy.
- **`docs/README.md` is out of date** (effort: small, impact: medium) — it
  still describes Smart Home as its own Settings tab in two places, which
  stopped being true in v2.1.0 when it became a subview inside
  Notifications. Also missing any mention of trigger areas, and the Settings
  screenshots in `docs/images/` predate both changes. Worth doing alongside
  whatever the next release is, so the screenshots are only retaken once.
- **Audit the 29 silent `catch {}` blocks** (effort: medium, impact: low) —
  most are deliberate and carry a comment saying why (offline, unauthorized,
  storage disabled), but they were never reviewed as a group, and a few
  could be hiding a real failure with nothing in the log. This is a read-
  through, not a rewrite: the outcome should mostly be confirming the
  existing behaviour, with a log line added where a failure would otherwise
  be invisible.

## From the 2026-08-04 statistics audit

Found while fixing the 24h-window bugs; both were raised and deliberately
deferred by the user in the same conversation.

- ~~**Antenna coverage: the top-5 mechanism doesn't actually resist
  outliers**~~ **Done in v2.1.10.** Fixed with two changes, the second
  suggested by the user after seeing the aircraft details panel's
  "Messages received" field: (1) `insertIntoTopK`/`mergeTopK` dedupe by
  `hex`, so a cell's top-5 are five distinct aircraft rather than five
  consecutive seconds of one; (2) `recordAntennaSample` now requires
  `messages >= 4` (readsb's own cumulative decode counter) before a sample
  is even offered, so a single lucky decode from a distant aircraft can't
  set a "best-ever" figure by itself either. The existing stored blob
  could not be migrated (no way to recover which aircraft contributed each
  historical number), so a mismatched shape is detected and started fresh,
  same as the redesign before this one — an established install loses its
  accumulated coverage history once, not silently corrupted going
  forward.
- ~~**Storage/write hygiene**~~ **Done, v2.1.14.** All three: (1)
  `db.js` now sets `PRAGMA journal_mode = WAL` / `synchronous = NORMAL` right
  after opening the connection; (2) `evaluateRangeRecordRule` now only
  updates an in-memory cache + dirty flag, persisted by the new
  `flushAllTimeMaxRangeKmIfDirty()` from the same periodic tick as
  `flushDailyStats` (and the graceful-shutdown path that also calls it) —
  `getAllTimeMaxRangeKm()` reads the cache, so Stats/the notification still
  see the record update immediately, only the SQLite write is deferred; (3)
  `db.js`'s `runBatch` is now exported and reentrant via `SAVEPOINT` (node:
  sqlite throws on a literal nested `BEGIN`), and `flushDailyStats` wraps its
  whole body in one outer `runBatch` — five transactions per flush tick down
  to one.
- ~~**Nothing resets antenna statistics when the receiver moves**~~ **Done
  in v2.1.9.** `POST /api/stats/antenna/reset` plus a button on the Server
  tab, clearing the coverage cells, the all-time range record and the
  rolling range samples. `PUT /api/settings` reports `homeMovedKm` so the
  UI can point out what went stale, but nothing is wiped automatically.
- ~~**Two different aircraft counts on one screen**~~ **Done in v2.1.9.**
  It turned out to be three, not two: readsb's own counters in the history
  charts, the server's `getTrackedAircraft().length` sent over the
  WebSocket for the live tile, and the browser's own set for the List
  total. Charts now use MLPR's tracked set (`recordTrackedCounts`), the
  live tile and the List both count the browser's set, and the server
  stopped sending a count at all. readsb's `total.max_distance` was removed
  end to end at the same time.
- **Historical `total_messages` rows are ~4x inflated** (effort: n/a,
  impact: none today) — `last1min.messages` is a rolling 60-second count
  that was being summed on every 15s poll, fixed in v2.1.8. Nothing
  displays this column, so there is nothing to correct; but a future "daily
  messages" chart would show a step at the upgrade and should either start
  from that date or say so.

## Experimental, may be removed

- **Stacked coverage bands** (Settings → Map → Coverage altitude band →
  "All, stacked", added v2.1.11) — every altitude band's shape layered on
  the map at once, highest altitude furthest back. Added to answer one
  question: is a layered view legible at all, or does it just read as mud?
  If it turns out to be the latter, `coverageBand: 'stacked'`, the
  `?band=stacked` endpoint branch, and `stackedCoverageFeatures` can all be
  removed cleanly — nothing else depends on them.
- **Coverage polygon: revisit spikes vs. skip-empty-sectors once real data
  has accumulated** (effort: none until then, impact: visual) — v2.1.11
  briefly shipped skipping unsampled sectors and joining real neighbours
  with a straight chord instead of drawing a spike to the home coordinate;
  reverted the same day (v2.1.12) after checking with the shoelace formula
  that a chord fills a real, non-zero wedge of *never-measured* area across
  a gap (~3,245 km² for one representative 18° gap), while a spike
  encloses exactly 0 km² across any gap, however wide — the chord version
  looked calmer but was the more dishonest of the two. Currently back to
  spikes (see CLAUDE.md's antenna-stats section for the full reasoning).
  Open question: does the spiky look actually fade as sectors fill in over
  real days/weeks, as suspected, or does a typical install settle at a
  sparsity where it stays rough long-term? Check against real accumulated
  data before changing this again. The coverage layer now refreshes every
  2s instead of 15s (v2.1.12, gated by a cheap `/revision` poll so idle
  ticks stay nearly free) specifically so this can be watched building up
  live rather than checked back on once a day.

### Measured and deliberately NOT done

- **Row-diffing the List table instead of rebuilding it.** Proposed as a
  performance fix, then measured: a full rebuild costs **0.52 ms at 25
  aircraft, 0.79 ms at 60, 1.95 ms at 150, 5.28 ms at 400**, once per
  second. At any realistic traffic level that is far below the point where
  anyone could perceive it, and diffing would put the selection highlight,
  the hover cross-highlight and three per-row event listeners at risk for
  no measurable gain. Revisit only if a real complaint appears, and measure
  again first.
- ~~**Paginating `/api/stats/registrations` server-side.**~~ **Done in
  v2.1.9.** This had been recorded here as a deliberate non-issue at
  present scale; measuring it changed the answer. It was 88 KB for 650
  registrations two days into an install (~135 bytes a row, growing with
  every airframe ever seen), and the browser was doing all the filtering,
  sorting and paging — so the pagination control was real while the paging
  was not. Both Stats tables are now searched, sorted and paged on the
  server (`stats-table.js`). What is left of the original concern: the
  full registrations cache still lives in the Pi's memory, because
  `recordSighting` needs it on every poll tick, and `getAllAirlinesSummary`
  re-runs its `GROUP BY` on every page click.
