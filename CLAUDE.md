# CLAUDE.md — My Local Plane Radar (MLPR)

This file is persistent memory for future sessions working on this repo.
Read it before making architectural decisions.

## What this is

A self-hosted web interface for a local ADS-B receiver on Raspberry Pi:
live map, receiver statistics, and a rule-based notification engine. It
replaces Virtual Radar Server.

readsb (wiedehopf fork) decodes the SDR feed and writes `/run/readsb/aircraft.json`.
MLPR only *reads* that file. **Never modify readsb, and never copy code from
readsb, tar1090, or dump1090** — they are GPL-licensed. MLPR runs as a
separate process with no linking, so it is not a derivative work. This
boundary is load-bearing for the license story of the whole project — do not
blur it, even to "borrow just one function."

## Hardware & environments

- **Production**: Raspberry Pi 3, 1 GB RAM, 4x Cortex-A53, aarch64.
  Raspberry Pi OS Lite (Trixie), headless, no desktop environment. System on
  SD card — writes are expensive, treat SD wear as a real constraint at every
  stage, not something to optimize later.
- **Development**: Debian on WSL2 (x86_64). Deploy to Pi via `git pull` +
  systemd service restart.
- readsb runs as its own systemd service, independent of MLPR.

### Node.js

- Target: **Node.js >= 22.13.0** (aiming for Node 24 LTS on both Pi and dev
  machine — same version on both sides).
- `node:sqlite` works **without** the `--experimental-sqlite` flag at this
  version. Do not add that flag anywhere (code or systemd unit).
- Confirmed on Node 24.18: no `ExperimentalWarning` at all, no flag needed.
  If an older/different patch version does print one, that's expected —
  don't globally suppress warnings with `--no-warnings` to hide it.
- `data/mlpr.db` path is overridable via `MLPR_DB_PATH` (used by tests to get
  an isolated temp database instead of touching the real one).
- The Pi's systemd unit must invoke Node from **`/usr/bin/node`** (NodeSource
  package), not a version manager (no nvm/fnm on the Pi).
- **Debian Trixie's `apt` only has Node 20.19**, which is too old. The install
  script/README must install from NodeSource, never `apt install nodejs`, and
  should detect a too-old system Node and abort with a clear message rather
  than silently running on an unsupported version.
- If `node:sqlite` ever proves insufficient for a real need, **ask before**
  adding a native dependency (e.g. `better-sqlite3`) — native modules built on
  x86 don't run on ARM, which is exactly the failure mode we're avoiding.

## Architecture

```
SDR + readsb
     |  writes once per second, atomic rename (no partial reads, no locking needed)
/run/readsb/aircraft.json   (tmpfs — reads are free)
     |  polled by backend
Backend (Node.js + Fastify + ws)
   |- current state in memory (hex -> aircraft)
   |- rule engine -> notifications (not implemented yet, see below)
   |- SQLite (node:sqlite): events + daily aggregates only
     |  WebSocket (deltas)          |  HTTP POST
Browser (map, MapLibre GL JS)    ntfy / Telegram (not implemented yet)
```

### Data source abstraction (build this first)

One interface, three implementations, selected by environment variable:

| Implementation | Purpose |
|---|---|
| `FileSource` | reads `/run/readsb/aircraft.json` — production on the Pi |
| `HttpSource` | fetches the same JSON over HTTP from the Pi — dev on WSL against live data |
| `ReplaySource` | replays recorded snapshots from `fixtures/` — tests and demo mode |

`scripts/record-fixtures.sh` records ~10 minutes of snapshots into `fixtures/`
for tests and the no-receiver demo mode.

**`HttpSource` fetch calls carry a timeout** (`AbortSignal.timeout`,
constructor option `timeoutMs`, default 3s) — unlike `FileSource`'s local
`fs.readFile`, a network request can simply hang forever with no error,
and `pollOnce()` runs on a plain `setInterval` (`index.js`) that does
**not** wait for the previous call to finish before firing the next one.
Without the timeout, one stalled connection meant a new hung request
piled up on top of it every second, forever, rather than just delaying a
tick.

### `aircraft.json` contract

One JSON object: `{ now, messages, aircraft: [...] }`. readsb writes to a temp
file and atomically renames it — we will never read a half-written file, so no
locking is needed on our side.

Fields we use on each aircraft object — **treat every one of these as
optional**, many are frequently absent. `server/src/normalize.js` is the
single place that reads raw readsb field names; everywhere else in the
codebase uses the camelCase names on the right.

- `hex` — 24-bit ICAO address, our primary key
- `flight` → `flight` — callsign, has trailing spaces, must be trimmed
- `lat`, `lon`, `seen_pos` → `seenPos` — position and its age in seconds
- `alt_baro` → `altBaro` — barometric altitude, **can be the string
  `"ground"` instead of a number** (becomes `onGround: true`, `altBaro`
  cleared)
- `alt_geom` → `altGeom`, `gs`, `track`, `baro_rate` → `baroRate`
- `ias`, `tas`, `mach` — indicated/true airspeed, Mach number
- `track_rate` → `trackRate`, `roll`, `mag_heading` → `magHeading`,
  `true_heading` → `trueHeading`, `geom_rate` → `geomRate`
- `squawk` — string, not a number (e.g. `"7700"`)
- `emergency` — string enum; `"none"` is normalized away to `undefined`
  (it's the common case and not worth a tile in the details panel)
- `category`, `version`, `type` → `sourceType` (renamed to avoid clashing
  with `typeCode`; this is the ADS-B/MLAT/Mode-S source-quality enum, e.g.
  `adsb_icao`), `r` → `registration`, `t` → `typeCode`, `desc`
- `dbFlags` — bitmask; bit 1 = `military`, bit 2 = `interesting`, bit 4 =
  `pia` (Privacy ICAO Address), bit 8 = `ladd` (Limiting Aircraft Data
  Displayed) — all four decoded in `normalizeAircraft`
- `nav_qnh` → `navQnh`, `nav_altitude_mcp` → `navAltitudeMcp`,
  `nav_altitude_fms` → `navAltitudeFms`, `nav_heading` → `navHeading`,
  `nav_modes` → `navModes` (array of strings, e.g. `["autopilot",
  "althold"]`) — `nav_modes` is deliberately **not** in `state.js`'s
  `CHANGE_FIELDS` (see below)
- `nic`, `rc`, `nic_baro` → `nicBaro`, `nac_p` → `nacP`, `nac_v` → `nacV`,
  `sil`, `sil_type` → `silType`, `gva`, `sda` — data-quality metrics, mostly
  passed straight through for the aircraft details panel's bottom tier
- `alert`, `spi` — 0/1 in the raw JSON, converted to booleans
- `rssi`, `messages`, `seen`
- `wd`, `ws`, `oat`, `tat` — readsb-computed wind/temperature, passed through
  as-is

Deliberately **not** read: `lastPosition`/`rr_lat`/`rr_lon` (position
fallback plumbing, not user-facing info), `acas_ra`/`gpsOkBefore`
(readsb's own docs mark these experimental — don't build anything on them).

Do not invent fields that aren't listed here. If something is needed that
isn't confirmed above, ask — verify against docs or a live file rather than
guessing.

`server/src/state.js`'s `CHANGE_FIELDS` decides which fields force an
immediate resend to the browser when they change vs. riding along passively
on the next resend triggered by something else. The rule of thumb: primary
flight-dynamics fields (position, altitude, speed, heading, squawk, nav
targets, alert/spi/emergency) are tracked; receiver/signal-quality metrics
and computed secondary stats (rssi, messages, seen, nic/rc/nac/sil/gva/sda,
wd/ws/oat/tat) are volatile. Arrays (`navModes`) can't go in `CHANGE_FIELDS`
at all — `normalizeAircraft` allocates a new array every poll, so a
reference-equality check would treat it as "changed" every single tick and
force a resend every second regardless of content.

### `receiver.json` and `stats.json` (siblings of `aircraft.json`)

Each `Source` also exposes `fetchReceiverInfo()` and `fetchStats()`, resolved
as sibling paths/URLs next to the configured `aircraft.json` location.
`ReplaySource` returns `null` for both (no synthetic receiver/stats data).

- `receiver.json` rarely changes — read **once at startup**. Fields we use:
  `lat`, `lon` (receiver position — see home-location resolution below),
  `version`, `refresh`.
- `stats.json` is rewritten by readsb roughly once a minute — poll it every
  ~15s and only act when `last1min.end` advances (see `stats-history.js`).
  Fields we use: top-level `aircraft_with_pos` + `aircraft_without_pos` (live
  aircraft count), `last1min.messages` (messages/min), `total.max_distance`
  (all-time max range, **in meters** — convert to km). readsb already computes
  max range itself; don't reimplement distance math for this.

### Home-location resolution (`server/src/home.js`)

Effective home = manual override (stored in the SQLite `config` table) if
set, else the `lat`/`lon` auto-detected from `receiver.json` at startup, else
`null`. Exposed via `GET`/`PUT /api/settings`. **Never hardcode real receiver
coordinates anywhere in code, tests, commits, or this file** — they're the
user's real home location. Use placeholder values (e.g. `50.0, 20.0`) in any
example/test data.

**Home marker** (`app.js`'s `homeMarker`/`refreshHomeLocation`, toggle
`showHomeMarker` in `settings-state.js`, Settings → Map): a small pulsing
dot at the receiver's location, rendered only when one is configured. This
is a **deliberate exception** to `/api/daylight`'s "never hand exact
coordinates to the browser" caution — a home marker drawn *on the map* is
the whole point of a personal plane radar and inherently requires the real
lat/lon client-side, unlike the daylight boolean which never needed to.
Reuses the existing `GET /api/settings` endpoint as-is (same one the Server
tab's own home-location field calls) rather than adding a second one, which
means the marker is subject to the exact same access control as that field:
if a Settings password is set, a browser without a valid session simply
won't see it (the fetch 401s, treated the same as "no home configured") —
consistent with home location being Server-tab-gated everywhere else,
not a special case that bypasses it.

**Initial map center** (2026-08-01, `app.js`'s `map.on('load')` handler):
before this, the map always started at a placeholder `[0, 0]`/zoom 2 (the
middle of the Atlantic) until the first aircraft-with-position happened to
arrive, then jumped there — effectively an arbitrary starting view, since
"first aircraft in the snapshot's array order" has no relation to where the
receiver actually is. Now `refreshHomeLocation()` is awaited (and moved
earlier, *before* the queued-message flush) right there in the same
handler; if a home location is configured (or auto-detected — same
resolution as the home marker above, reused as-is, no new coordinate
source), `map.jumpTo({ center: [homeLocation.lon, homeLocation.lat], zoom:
INITIAL_ZOOM })` runs immediately and sets `hasCentered = true` before any
queued snapshot is processed, so the old "first aircraft" jump in
`applyAircraftUpdate` never fires. Falls through to that exact old fallback
unchanged when no home is configured (or the browser isn't authorized to
see it) — there's no other reference point to use in that case. Independent
of `showHomeMarker`: whether the pulsing dot itself is drawn is a separate
display preference, unrelated to whether the known coordinate is usable as
a starting view.
`INITIAL_ZOOM` (9) is shared between the two paths so they read as one
deliberate starting zoom, not two coincidentally-equal magic numbers. This
does **not** touch the pre-existing "jump to home on every reconnect"
question — `hasCentered` still resets on every full snapshot (`resetAll()`,
i.e. on every WS reconnect, not just the first page load) and the home
recheck only lives in the one-time `map.on('load')` handler, so a
mid-session reconnect still falls back to "first aircraft in the new
snapshot" exactly as before — deliberately unchanged, out of scope for this
fix.

## License policy

- Project license: **MIT** (`LICENSE` at repo root).
- Allowed dependency licenses: **MIT, ISC, BSD-2-Clause, BSD-3-Clause,
  Apache-2.0, CC0, public domain.**
- **AGPL is forbidden, no exceptions** — it would force a license change for
  network-served apps like this one.
- GPL/LGPL dependencies: **ask the user first**, every time.
- **Never add a new dependency without asking.** When proposing one, state:
  name, license, size, and why it can't reasonably be hand-written in a few
  dozen lines.
- Keep `THIRD_PARTY.md` current whenever a dependency is added or removed.
- Never let private data (home location/coordinates, personal API tokens,
  etc.) land in files committed to the public repo.

### Repo hygiene

- `.gitattributes`: `* text=auto eol=lf` (CRLF from Windows would break shell
  scripts on the Pi).
- `.gitignore`: `node_modules/`, `*.db`, `*.db-wal`, `*.db-shm`, `*.pmtiles`,
  `data/`, `fixtures/*.json`, `.env`.
- **Never commit `node_modules`** — modules built on x86 don't run on ARM.
- Large data files are always fetched by script, never checked into the repo.

## Hard performance rules (Raspberry Pi 3, 1 GB RAM) — non-negotiable

1. **Never send the full `aircraft.json` to the browser.** Keep state in
   memory; send only deltas (aircraft that actually changed) over WebSocket.
2. **One file read per second, regardless of client count.** All clients are
   served from the same in-memory state.
3. **Round values before sending**: lat/lon to 5 decimal places, altitude to
   25 ft. Roughly halves JSON size for free.
4. **SQLite gets events and daily aggregates only — never raw position
   history.** The SD card cannot survive per-position writes.
5. **Batch writes in transactions every 30–60 seconds.** No per-row INSERTs
   in a loop.
6. Current state lives in RAM only. A service restart losing live state is
   acceptable and expected.
7. **No Docker.** On 1 GB RAM it's unnecessary overhead — install via systemd
   + a plain script.
8. Backend budget: **up to 150 MB RSS**. systemd unit sets `MemoryMax=300M`
   and `NODE_OPTIONS=--max-old-space-size=192` so a leak can't OOM-kill readsb
   too.
9. The `hex -> aircraft` map must not grow unbounded — aircraft unseen for a
   few minutes must be evicted from state.

## Stack

- Backend: Node.js (>=22.13.0) + Fastify + `ws`.
- Storage: built-in `node:sqlite` — zero native compilation (critical: native
  modules built on x86 don't run on ARM).
- Frontend: plain JavaScript (ES modules) + MapLibre GL JS. **No framework,
  no build step.** Static files served directly by Fastify.
- Basemap: two modes, switchable in Settings → Map (`basemapMode`,
  `public/js/settings-state.js`), **online is the default**:
  - **Online**: OpenFreeMap (`https://tiles.openfreemap.org`) vector tiles —
    no API key, no signup, no rate limit. We do **not** use one of their
    ready-made styles (liberty/positron/bright) as-is — checked live and none
    fit the dark green/blue/black theme without a full repaint anyway, so
    `public/mapstyles/online-dark.json` is our own MapLibre style spec
    authored against their `openmaptiles`-schema vector source (~20 curated
    layers: water, landcover, roads by class, railways, boundaries, place
    labels, and — fitting for a plane radar — airports/runways/taxiways
    picked out in the same green as a fresh aircraft blip). Keep this file in
    sync by hand if OpenFreeMap ever changes their schema; it intentionally
    does not inherit from their styles, so it won't drift silently.
  - **Offline**: Natural Earth 1:10m GeoJSON (coastlines, borders, rivers,
    major cities), ~20 MB, public domain. Fetched by
    `scripts/fetch-mapdata.sh` at install time — **never committed**.
  - **Map theme** (`mapTheme`, also in `settings-state.js`, default
    `light`, values `light` | `dark` | `auto`): independent of
    `basemapMode` — dark/light applies to *both* online and offline modes,
    four combinations total. `auto` follows sunrise/sunset **at the
    receiver**: `app.js`'s `resolveMapTheme` turns it into a concrete
    light/dark before anything else sees it, and `lastRequestedMapTheme`
    tracks the *resolved* value so an automatic sunset flip registers as a
    change. The daylight decision is made server-side
    (`server/src/daylight.js`, a standard sunrise-equation implementation,
    no dependency) and exposed as `GET /api/daylight` → `{ isDaylight }` —
    deliberately a bare boolean and deliberately **not** behind
    `requireSettingsAuth`, since every browser needs it whether or not it's
    logged in to Settings, and handing out the receiver's coordinates
    instead would leak the user's home location. `isDaylight: null` means no
    home location is configured, in which case the client falls back to the
    OS `prefers-color-scheme`. An open tab re-checks every 10 minutes so it
    flips itself at dusk without a reload. Watch the longitude sign if you
    ever touch `daylight.js`: `lon` is east-positive here, so solar noon is
    `n - lon/360`; textbook statements of the equation use west-positive
    longitude and read `+ l_w/360`, and getting it backwards shifts results
    by twice the offset (caught by the solstice tests, which check against
    published almanac times). This is a **map-only** theme, not
    the app's own UI theme (bottom bar/panels/settings stay dark always —
    deliberately, per explicit request, since this is meant to be a
    night-readable radar display regardless of the map underneath). Online
    light mode is `public/mapstyles/online-light.json`, structurally
    identical to `online-dark.json` (same layer ids/filters/zoom levels, only
    `paint` colors differ) — keep the two in sync by hand for anything beyond
    color. Offline light mode reuses the same Natural Earth GeoJSON layers
    with different paint values from `OFFLINE_PALETTES` in `basemap.js`
    (coastline/border/river colors read fine on both a near-black and a
    near-white background already; only the city dots and the background
    itself actually flip between themes).
  - Switching modes calls `map.setStyle(...)` on the existing MapLibre
    instance (`public/js/basemap.js`'s `applyBasemapMode`) — no page reload,
    aircraft markers survive (DOM markers aren't part of the style). Because
    `setStyle` wipes all sources/layers, the trail source/layer is re-added
    every time via the `style.load` event, and the offline GeoJSON layers are
    likewise re-added when switching back to offline.
  - **Session-scoped auto-fallback**: if the online style can't be reached
    (preflight fetch of OpenFreeMap's TileJSON fails, or a later `error`
    event on the `openmaptiles` source looks like a network failure),
    `basemap.js` switches to offline automatically for the rest of that
    browser tab and won't retry online again until the page is reloaded —
    the persisted `basemapMode` setting itself is untouched, so a reload (or
    the user manually reselecting "Online" in Settings) tries online again.
    Settings shows a small notice when this fallback is currently active.
    The network-error watcher (`armOnlineErrorWatch`) is armed only once per
    map instance and left attached forever — it reads the module-level
    `currentTheme`/`currentCallbacks` at fire time rather than closing over
    them at arm time, so a later fallback triggered by a runtime error uses
    whatever theme is *currently* selected, not whatever was active the first
    time the watcher got armed. Caught by a mock-`map` unit test during
    development; don't reintroduce a closure over theme here.
  - **Attribution**: OSM data is ODbL-licensed, which requires attribution —
    not optional. We disabled MapLibre's default `AttributionControl`
    (Stage 1), so instead there's our own small custom-styled attribution
    div (`#mlpr-attribution` in `index.html`/`style.css`) with two parts: a
    "MapLibre" credit (`maplibre.org`) always shown in both modes, and the
    data credit (`#mlpr-osm-attribution`, toggled by
    `updateAttributionVisibility()` in `app.js`) shown only while
    `basemapMode` is effectively online. The data credit must name **three**
    separate parties, not just OSM — verified against
    [OpenFreeMap's own quick-start docs](https://openfreemap.org/quick_start/),
    which specify the exact required text: "OpenFreeMap © OpenMapTiles Data
    from OpenStreetMap" (each name individually linked — OpenFreeMap to
    `openfreemap.org`, OpenMapTiles to `openmaptiles.org`, OpenStreetMap to
    `openstreetmap.org/copyright`). An earlier version of this credit only
    said "© OpenStreetMap contributors", omitting the tile host
    (OpenFreeMap) and the schema/processing project (OpenMapTiles) —
    caught and fixed 2026-07-28. Because the required format has plain text
    ("©", "Data from") *between* the links rather than every word being a
    link, `#mlpr-attribution` needs its own explicit `color` — the old
    all-link version never needed one, so this was a real (if minor)
    invisible-text bug the moment the fix went in, not just a style
    preference. Note MapLibre GL JS itself (BSD-3-Clause) does **not**
    legally require an on-map credit — only keeping the license text in the
    repo/docs (already covered by `THIRD_PARTY.md`/`LICENSE`) — the MapLibre
    credit is included anyway per explicit request, not a license
    obligation. Offline mode (Natural Earth, public domain) needs no data
    attribution, hence only the MapLibre half shows.
  - **Position**: pinned to the true bottom-**left** corner (`bottom: 6px`)
    only on screens `>=720px` wide (`public/css/style.css`, reusing the
    breakpoint the bottom-sheet/side-panel split already uses) — below that
    it stays raised above the bottom bar's height
    (`calc(var(--bottom-bar-height) + 4px)`), the old default for every
    width. Below ~420px wide, a full-length credit pinned to the literal
    corner collides with the List pill button, since the bottom bar's
    buttons are centered and leave little room beside a corner element on
    either side (measured empirically, not guessed — see the git history
    for this line). This was **not** an issue before the bottom bar was
    redesigned as floating pills (see below): the old opaque full-width bar
    was the reason for the raised position everywhere, and simply hadn't
    been revisited when that redesign made the bar transparent, which is
    what the raised position on wide screens looked like a bug (floating in
    empty space above the actual corner) rather than a deliberate choice.
    **Moved from the right to the left edge 2026-07-28**, when the List
    panel gained its own `.mlpr-panel-fill` (see below): on desktop the List
    side panel docks to the *right* edge of the screen and, once it was
    extended to reach the true bottom, would otherwise sit directly under a
    right-anchored credit. Confirmed against OSM's own attribution
    guidelines (osmfoundation.org/wiki/Licence/Attribution_Guidelines:
    "While the lower right corner is traditional, any corner of the map is
    acceptable") that this isn't a license constraint — moving corners is
    purely to dodge the new overlap.
    **Below 720px it moves to the top-right corner instead** (2026-08-02,
    requested): the bottom of a phone screen is the busiest part of the app
    (floating pills, the "i" button, a bottom sheet sliding up over all of
    it) while the top edge is empty map. Only the credit moves — the "i"
    credits button stays in the bottom-left stack — which is why it's a
    `position: fixed` override on `#mlpr-attribution` in a `max-width: 719px`
    block rather than a reordering inside `#mlpr-corner-info`'s flex column.
    Same OSM guideline as above covers it ("any corner of the map is
    acceptable"), and OpenFreeMap's terms specify the wording, not the
    placement.
  - **Credits panel byline**: "MLPR v<version> by Maurycy Kaczmarek", the
    whole line a link to the GitHub repo. The version comes from
    `GET /api/version` (`server.js`, reading `package.json` — ungated, a
    version number is not a secret) and is filled in by `panels.js`, so a
    release only ever has to bump `package.json`; a failed fetch just leaves
    the byline reading as it did before.
- Icons: inline SVG only, authored in-repo. No icon libraries, icon fonts, or
  CDNs — everything must work fully offline.

## Networking

- Default port **1090** (nod to 1090 MHz), configurable via `MLPR_PORT`.
  Never use 8080, 8085 (other apps on this host) or 30001–30005 / 30104
  (readsb's ports).
- Bind `0.0.0.0`, local-network access.
- App root `/` serves the interface directly (no `/index.html` needed).
- No authentication (home LAN app). But **never expose an endpoint that runs
  system commands**, in case this ever ends up reachable from outside.
- Every response carries `X-Frame-Options: DENY` and `X-Content-Type-Options:
  nosniff` (one `onSend` hook in `server.js`, no dependency) — cheap,
  no-downside hardening against clickjacking/MIME-sniffing for the same
  "might end up reachable from outside" reason as the line above.

## UI

- One URL, one responsive interface — no separate mobile build. Works well on
  phone (portrait), laptop, and a wall-mounted big screen.
- Auto-detects browser/system language; ships Polish + English at launch.
- Full-screen map, bottom bar with three small labeled icon buttons (own
  inline SVG, translated label under each via `t()`, semi-transparent pill
  background, hover/press feedback): List (sortable, searchable, clickable,
  click centers map), Stats, Settings (theme, units, altitude filter, layer
  visibility). Deliberately compact/centered, not stretched across the bar.
  List (`public/js/list.js`) shows a total-aircraft count above the table
  (always the live unfiltered count, not the search-filtered row count —
  "how many are there," not "how many am I currently looking at"), and
  highlights whichever row matches the currently-selected aircraft
  (`.mlpr-list-row-selected`). Selection itself is `app.js`'s own
  `selectedHex` (used in over a dozen places there already, so it stays the
  source of truth) mirrored into `radar-state.js`'s `setSelectedHex`/
  `getSelectedHex` purely so other UI modules can read it without `app.js`
  importing back from them — distinct from that file's `setInspectedHex`/
  `getInspectedHex`, which is specifically "whose full details panel is
  open," a narrower, later action. The search box
  (`#mlpr-list-search`) matches flight/callsign, hex, type, and
  registration, and — like the Stats registrations table's search box —
  lives outside the subtree `drawTable()` rebuilds on every redraw
  (roughly once a second with live traffic, per `radar-state.js`'s
  batching), so typing in it doesn't lose focus every redraw. Sorting
  compares `sortValue()`'s raw underlying values (a real number, or `-1`
  for on-ground so it always sorts as the lowest altitude, or `null` for
  genuinely missing data which always sorts last regardless of direction),
  **not** `formatCell()`'s display strings — sorting `"1200 ft"` against
  `"On ground"` as text put "on ground" wherever it happened to collate
  alphabetically against numbers-with-units, not at the bottom of the
  altitude range where it belongs. **Mode-S-only contacts (no ADS-B
  position) are shown, flagged with a small crossed-out pin icon next to
  the callsign** (`NO_POSITION_ICON` in `list.js`) rather than omitted —
  `app.js`'s `applyAircraftUpdate` used to bail out entirely (before ever
  calling `noteAircraft`) for any aircraft missing `lat`/`lon`, which meant
  they never reached the List, Stats, or any total count at all. Reported
  live as "why does tar1090 show more aircraft than MLPR's list"
  (2026-07-28) — tar1090/Virtual Radar Server both list these. Fixed by
  splitting `applyAircraftUpdate`'s two concerns: `noteAircraft` (and the
  `aircraftState` bookkeeping entry — `lastUpdateAt`/`goneAt`/fade-then-
  forget timers) now always runs; only the marker-placement half (`new
  maplibregl.Marker(...)`, trail recording, the info popup, initial
  map-centering) is still gated on having a real position, since none of
  that can exist without one. This didn't need new null-guards anywhere
  else — every existing consumer of `aircraftState` entries
  (`showInfoPopup`, `selectAndCenter`, `setSelectionHighlight`, the
  fade/forget tick) already tolerated a `null` marker/`lastLngLat`
  defensively, so a position-less entry (`marker: null, lastLngLat: null`)
  just flows through the same machinery a marker fading out already does.
  A position that's later lost mid-flight (rare) leaves the existing
  marker exactly where it last was rather than deleting it — the regular
  fade/forget timers retire it on schedule if a real position never
  returns.
- **List columns and sort order are user-configurable** (2026-07-28,
  requested to match Virtual Radar Server/tar1090-style flexibility): a
  "Configure" button at the top of the List panel (`#mlpr-list-configure`)
  swaps the table view for an in-place config view within the same
  container (`display:none` toggle, same pattern `settings.js` already uses
  for its tab panels — no separate panel/modal machinery needed). **Every
  edit auto-saves** — no Save/Cancel step (removed after user feedback
  2026-07-28: a draft-then-Save step just added friction here). Each row
  control's own handler calls `updateSettings()` directly, then
  `renderConfigView()` re-renders the whole config view fresh from
  `getSettings()` — safe to do unconditionally because it's only ever
  triggered by a `<select>`'s `change` (fires once a choice is already
  committed, unlike a text input's `input` event mid-keystroke) or a button
  click, never mid-interaction. The underlying table
  (`drawTable`, subscribed to `onSettingsChange`) updates live alongside it
  for the same reason. Column *and* sort-level rows both get ↑/↓ reorder
  buttons plus Remove (disabled at one remaining column/level — an empty
  table or a fully-unordered list aren't useful states) — sort levels
  originally only had Remove, reordering meant deleting and re-adding from
  scratch, fixed on the same feedback round as the auto-save change.
  Persisted per-browser in `settings-state.js`: `listColumns` (ordered array
  of `public/js/list-fields.js` keys), `listSortLevels` (ordered array of
  `{key, asc}` — VRS's fixed "sort by / then by / then by" three-line UI,
  generalized to any number of add/removable levels instead), and
  `listPositionFirst` (aircraft with a known position sort before those
  without, applied as a pre-sort grouping ahead of the configured levels).
  Defaults match the pre-configurable 4-column layout exactly
  (`flight`/`typeCode`/`altBaro`/`gs`, single ascending flight sort), so
  existing installs see no visible change until they open Configure.
  Clicking a column header still gives quick single-column sort like
  before, but now **persists** through the same `listSortLevels` setting
  instead of resetting on reload.
  **Configure is a genuinely separate, independent window in the desktop
  side-panel layout — `#panel` itself never changes size, position, or
  content when it opens or closes** (2026-07-28, after two earlier same-day
  attempts: first a passive "only show side by side if the panel happens to
  already be wide enough" check, then an auto-grow-the-panel version — both
  wrong per explicit follow-up feedback; the actual ask was that `#panel`,
  its width, and its own "Configure"/"Open fullscreen" buttons must be
  completely unaffected by opening Configure, full stop). `list.js`'s
  `currentMode()` picks one of three presentations:
  - **`'floating'`** (`!fullscreen && isSidePanelLayout()`, the normal
    desktop case): Configure renders into `#list-config-window` — a
    top-level `<section>` in `index.html`, a *sibling* of `#panel`, not
    nested inside it anywhere. `positionConfigWindow()` glues its right
    edge to `#panel`'s actual left edge (`getBoundingClientRect()`, not
    recomputed from settings — correct whether that edge is at the default
    width, a persisted drag-resize, or mid-drag) plus a small
    `CONFIG_WINDOW_GAP` (12px), so it reads as touching-but-separate rather
    than fused. Since it's a different DOM element entirely, `#panel` is
    structurally incapable of changing when this opens — not just
    "unlikely to," genuinely can't.
  - **`'inline'`** (`fullscreen`, i.e. `FULLSCREEN_MODALS.listFull`): no
    "beside it" to float into (the modal already spans the full available
    width) but doesn't usually need one — `#mlpr-list-config-view` renders
    *nested* in `#mlpr-list-body` instead, `row-reverse` in CSS putting it
    on the left of the table, shown once the modal's own measured width
    (`ResizeObserver` on `container`) clears `FULLSCREEN_SIDE_BY_SIDE_MIN_
    WIDTH` (760px) — falls back to swapping on a narrow phone even in
    fullscreen, where there's genuinely no room either way.
  - **`'swap'`** (mobile bottom sheet, not fullscreen): `#mlpr-list-config-
    view` replaces the table in place — the original, simplest behavior,
    unchanged since this feature's first version.
  `updateLayout()` computes the mode fresh each call and only re-renders
  into a *different* target than last time (`activeConfigTarget`) — covers
  both a plain open (target goes from `null` to real) and a mode change
  mid-session (e.g. the browser window crossing the side-panel breakpoint
  while Configure was already open in 'floating' mode). One `ResizeObserver`
  on `container` drives both the 'floating' case's repositioning (dragging
  `#panel`'s resize handle changes `#panel-content`'s width too, which is
  what `container` actually is here) and the 'inline' case's width
  measurement — reacting to a `container` resize covers both reasons to
  care, so one observer is enough.
  Whenever list and config are both visible ('floating' or wide 'inline'),
  a column/sort change's effect on the table is visible immediately without
  closing Configure first to check — this part falls out of the auto-save
  behavior above for free, nothing about *when* settings commit changed.
  **Closing**: re-clicking "Configure" *toggles* it closed (`toggleConfigView`,
  button gets an `active` class reusing `.mlpr-bar-btn.active`'s look as the
  visual cue for which action it currently performs), and a small `✕` in the
  config window's own header (`#mlpr-listconfig-close`) does the same thing
  as a second, more discoverable affordance — both call the identical
  `closeConfigView()`.
  **Visually, list and config read as two independent windows stuck
  together, not one panel with two columns**: `#mlpr-list-config-view` and
  `#list-config-window` share one CSS rule for the "independent window"
  look (background/border/rounded corners, `#0b1116` on `#1c2e3a`, matching
  `.mlpr-stat-chart` cards elsewhere) — `#list-config-window` additionally
  gets `position: fixed` (glued to `#panel` as above) since it's the
  genuinely-separate version; `#mlpr-list-config-view` stays in normal
  document flow since it's still nested (the 'inline'/'swap' cases).
  `.mlpr-listconfig-header` reads as that card's own title bar (negative
  margin canceling the card's own padding just for that strip, so the
  `border-bottom` spans the full width — same shape/role as `#panel-header`
  one level up). In 'inline' mode specifically, `#mlpr-list-view` gets the
  identical card treatment too, so both sides are visually symmetric. The
  toolbar (`.mlpr-list-toolbar`, "Configure"/"Open fullscreen") is a sibling
  of `#mlpr-list-body` and is never touched by any layout/mode logic, so it
  can't move, duplicate, or change between the two windows. The shared
  `#mlpr-list-config-view, #list-config-window` rule also needs its own
  explicit `color` — `#mlpr-list-config-view` already inherits a readable
  one from `#panel-content`, so this was a no-op there, but
  `#list-config-window` is a genuinely separate top-level element with no
  such ancestor; without it, anything inside relying on inherited color
  (e.g. the "Show aircraft with a known position first" checkbox label —
  everything else nearby happens to set its own color explicitly) fell back
  to the browser default black, invisible on the near-black card background.
  Reported live, 2026-07-28; same category of bug as the OpenFreeMap
  attribution's missing `color` documented above.
  **Two `<fieldset>` gotchas hit while building the narrow (340px)
  `#list-config-window`**, both worth remembering for any future
  narrow-container work: (1) a sort row (two `<select>`s + up/down/remove
  buttons) overflowed straight past the window's edge instead of its
  `<select>`s shrinking, despite `flex: 1; min-width: 0` on them —
  `<fieldset>` has a browser-default `min-width: min-content` that ignores
  its actual container width and keeps expanding to fit its content's
  intrinsic minimum, so `.mlpr-settings-group` (the fieldset class both
  "Columns" and "Sort order" use) now has an explicit `min-width: 0` to
  override that; harmless everywhere else that class is used, since
  Settings' own tabs are never this width-constrained. (2) Once that was
  fixed, the row still didn't fit with a full-text "Remove" button — both
  config sections' remove buttons became icon-only (`✕`, `aria-label`
  keeps the real word) to match the already-icon-only ↑/↓ buttons, which is
  what actually made the row fit.
  `list-fields.js` is a flat catalog of every field the list can show —
  the same field set `aircraft-details.js`'s `CORE_SPEC`/`EXTRA_SPEC`
  expose in the aircraft details panel, flattened out of that file's
  tile/cluster grouping (a details-panel-only display concern), plus two
  additions: `distance` (home location to aircraft position, reusing
  `geo.js`'s existing `distanceKm` — no new distance math) and `military`
  (already existed as a details-panel flag hidden unless true; here it's an
  always-visible boolean column instead, since a blank table cell reads as
  missing data in a way an omitted panel tile doesn't). Reuses
  `aircraft-details.js`'s formatting helpers and label maps directly (now
  exported from there) rather than duplicating them. Each catalog entry
  separates `format()` (display string, or a raw sentinel like
  `GROUND_MARKER` that `list.js`'s `formatCell` — not the catalog itself,
  which stays i18n-free like `aircraft-details.js` — translates via `t()`,
  same split `aircraft-panel.js` already uses for the details panel) from
  `sortValue()` (the raw comparable value), mirroring the sort/display
  split the List already had for altitude before this catalog existed.
  Dropdowns populate from `sortedFieldOptions()`, alphabetized by the
  *current-language* translated label as requested.
  An "Open fullscreen" button opens the exact same `renderListPanel` view in
  `panels.js`'s `FULLSCREEN_MODALS.listFull` — same column/sort
  configuration, just more screen space, not a separate config. Inside
  fullscreen, that button is replaced by an "Exit fullscreen" one
  (`fullscreen` param on `renderListPanel` picks which of the two renders)
  that calls the now-exported `openPanel('list')` to switch back to the
  small panel/bottom sheet — originally missing entirely (no way back short
  of closing the whole thing and reopening from the bottom bar), caught in
  the same feedback round as the auto-save change above. Uses the identical
  "just switch, don't push/pop history" path `panels.js` already has for
  List↔Stats (`openPanel` calls `hideModalUI()` first), so it doesn't leave
  a stray history entry. Both `PANELS.list` and
  `FULLSCREEN_MODALS.listFull` carry a `fill: true` flag that
  `openPanel`/`openFullscreenModal` turn into a `mlpr-panel-fill` class on
  open: List reaches the true screen bottom instead of stopping above the
  bottom bar, same as the map itself already does, so the table gets the
  full available height instead of leaving a wasted strip below it. The
  floating bottom-bar pills end up on top of the last rows (same visual
  relationship they already have with the map); `#panel.mlpr-panel-fill
  #panel-content` gets extra bottom padding so those rows stay reachable by
  scrolling past the pills. Selector specificity (an id+class selector
  beats the plain `#panel` id selector inside the `@media (min-width:
  900px)` desktop-layout block) is what makes one small rule apply

  **Update, 2026-08-01: `fill: true` now applies to every panel/modal, not
  just List.** Settings/Stats/aircraft-details were originally left out —
  List got the flag purely because its table needed the extra height, and
  the other three had no such need at the time. Left short, though, their
  `#panel`/`#fullscreen-modal` box stops at `bottom: var(--bottom-bar-height)`
  and the live map (aircraft, trails, place labels) is plainly visible
  behind the floating bottom-bar pills in that gap — reported live as a
  visual bug (screenshots of Stats and Settings both showing the map
  bleeding through above the bar), not something anyone had wanted on
  purpose. Since the CSS side of `mlpr-panel-fill` was already generic
  (applies to any `#panel`/`#fullscreen-modal` with the class, not
  List-specific selectors), the fix was just adding `fill: true` to
  `PANELS.settings`, `PANELS.aircraft`, and `FULLSCREEN_MODALS.stats` too —
  no new CSS mechanism needed.
  correctly on both the mobile and desktop layouts without duplicating it
  inside that media query.
- **The side panel's width is drag-resizable** (2026-07-28, requested once
  List's column count grew past what the fixed 440px side panel could show
  comfortably) — `#panel-resize-handle` (`index.html`, a thin strip on
  `#panel`'s left edge, only shown/active in the >=900px side-panel layout)
  wired up in `panels.js` with plain `pointerdown`/`pointermove`/`pointerup`
  (`setPointerCapture` so the drag tracks even if the cursor outruns the
  8px-wide handle). `#panel` is right-docked in that layout (`right: 0`
  implicit from the base rule, `left: auto` in the `>=900px` override), so
  width is computed from the *fixed* right edge captured once at drag-start
  minus the current pointer X, not from the (moving) left edge. Persisted
  per-browser as `sidePanelWidth` in `settings-state.js` (default 440,
  matching the old hardcoded CSS value byte-for-byte so nobody who hasn't
  dragged sees a change), clamped to `[320, min(900, viewport width − 40)]`.
  Applied as an inline `style.width` on every panel open and on window
  resize (`applySidePanelWidth`) — **deliberately gated on
  `matchMedia('(min-width: 900px)').matches`**, cleared to `''` otherwise:
  an inline style wins over the stylesheet's media-query rules regardless
  of specificity, so applying it unconditionally would break the mobile
  full-width bottom sheet by pinning it to a fixed pixel width. This is
  shared `#panel` chrome, not List-specific — Settings and the aircraft
  details panel get the same resizable width for free, which is fine (more
  room never hurts) rather than something to special-case away.
- List and Settings are bottom sheets on phones, a side panel on large
  screens; closable via X, Android/iOS back-gesture, click on the overlay,
  or **Escape** (`panels.js`'s top-level `keydown` listener — closes
  whichever of `currentPanel`/`currentModal` is open via the same
  `closePanel`/`closeFullscreenModal` functions the X button uses, so it
  consumes the pushed history entry the same way; a no-op if nothing is
  open). Map stays visible on desktop.
  **Stats is a full-screen view instead** (`#fullscreen-modal` in
  `index.html`, `FULLSCREEN_MODALS` registry in `panels.js`, separate from
  `PANELS`) — deliberately more screen real estate for the growing set of
  stats options, but still leaves the bottom bar reachable (`z-index` below
  the bar, same as the bottom-sheet/side panel) so switching directly to
  List/Settings doesn't require closing it first. `panels.js` treats "a
  history entry is pushed" and "something is open" as the same fact shared
  across *both* mechanisms — switching directly between them (e.g. List ->
  Stats) must not push/pop history, only actually opening from closed or
  closing to nothing should. Getting this wrong (each mechanism managing its
  own history push/pop independently) causes a newly-opened view to
  self-close immediately, because closing the other one first triggers an
  async `history.back()` that then fires *after* the new one has already
  pushed its own entry.
- **Accessibility basics, `panels.js`**: `<html lang>` and every close/
  bottom-bar button's `aria-label` used to be hardcoded English in
  `index.html`, never matching the Polish UI — `panels.js` is imported by
  `app.js` and evaluated (including its own top-level code) *before*
  `app.js`'s own top-level `new maplibregl.Map(...)`, so it's a reliable
  place to set both regardless of whether the map itself ever comes up;
  `document.documentElement.lang = getLanguage()` and each button's
  `aria-label` are set from the same `t()`/title source as its visible
  label, so they can't drift out of sync again. Opening a panel/modal also
  moves focus onto its close button immediately (not gated on the
  render, which can be async) and traps Tab/Shift+Tab within it
  (`trapFocus`, standard modal dialog behavior — a `keydown` on a
  `display:none` container never fires, so no open/closed guard is
  needed), and closing restores focus to whatever had it before —
  `lastFocusedElement`, captured only on a genuinely closed → open
  transition, **not** on a direct switch between panel and modal (e.g.
  List → Stats), which would otherwise capture focus already inside the
  panel being switched *away* from.
- **Manual language override** (`language` in `settings-state.js`,
  Settings → General, default `'auto'`): `i18n.js`'s `detectLanguage()`
  checks this before falling back to `navigator.language` —
  `settings-state.js` has no imports of its own, so `i18n.js` importing
  `getSettings` from it can't create a circular import. Applying a change
  is a straight `location.reload()` right after saving
  (`settings.js`'s `#mlpr-language` handler), not a live re-render:
  translations are baked into static markup all over the app (button
  labels, `aria-label`s, `document.documentElement.lang` above) at
  render time, not re-evaluated on the fly, so there's no single place
  to redo that live without risking some already-rendered panel being
  left in the old language. The two language options in the `<select>`
  are shown in their own native name ("English"/"Polski", not run
  through `t()`) — the standard convention for a language picker, so
  they stay readable regardless of whichever language is currently
  active.
- **`.mlpr-info-icon` tooltips are real `<button>`s, not
  `<span tabindex="0">`** — some mobile browsers don't reliably move focus
  to a plain focusable span on tap (which is what the CSS `:hover`/`:focus`
  tooltip reveal depends on), but a native button always is. `style.css`
  resets the browser's default button chrome back to the same look the
  span had.
- **Dark theme is the default** — this is a radar display, must be readable
  at night without glare. Color theme: green, blue, black.
- Plane icon rotates to heading. Click shows trail + basic info with a "show
  more details" button that opens the full aircraft details panel (see
  below) — reuses the same bottom-sheet/side-panel mechanism as List/Settings
  (`public/js/panels.js`'s `PANELS.aircraft`), just not tied to a bottom-bar
  button — opened contextually via `openPanel('aircraft')` after
  `setInspectedHex(hex)` (`radar-state.js`). The info popup (`showInfoPopup`
  in `app.js`) is offset away from the marker (`Math.round(aircraftIconSize
  / 2) + 7`, not a fixed constant) — MapLibre's default popup offset is 0,
  which anchors the popup's tip exactly on the aircraft's coordinate, and
  since the marker is centered on that same point, an unoffset popup covers
  half the icon. `showInfoPopup` **reuses the existing popup instance**
  (`setLngLat`/`setHTML` on `activePopup`) when it's already showing the
  currently-selected aircraft, only `.remove()`-ing and creating a genuinely
  new one when the selection changes — `applyAircraftUpdate` calls this once
  per position tick for the selected aircraft (so roughly once a second for
  active traffic), and a new module-level `activePopupHex` (kept in sync
  everywhere `activePopup` is cleared) is what lets `showInfoPopup` tell
  "same aircraft, just refresh in place" apart from "different aircraft,
  need a new popup". The `Popup` is constructed with **`focusAfterOpen:
  false`**, overriding MapLibre's own default of `true`. First reported live
  2026-07-28 (impossible to pick an option from an open native `<select>`
  anywhere in the app while a popup's aircraft kept updating in the
  background — every tick force-closed whatever dropdown was open, since
  browsers close an open `<select>` when focus moves elsewhere) and *fixed*
  at the time by adding the reuse-the-instance branch above, on the theory
  that `.addTo()` was the only thing that calls MapLibre's internal
  `_focusFirstElement()` and that avoiding it on the reuse path would be
  enough. That theory was wrong, just incompletely: reported again
  2026-08-01, identical symptom, still happening on every tick despite the
  reuse branch already being in place. Reading MapLibre's actual `Popup`
  source (not re-guessing) showed `setDOMContent()` — called internally by
  *every* `setHTML()`, including the reuse path's own `setHTML()` call —
  *also* calls `_focusFirstElement()` unconditionally, gated only by
  `options.focusAfterOpen`, completely independent of whether `.addTo()`
  ever ran. So the reuse branch stopped one focus-stealing path but not the
  other, and the *other* one is the one that actually fires every tick.
  `focusAfterOpen: false` disables `_focusFirstElement()` at its one real
  gate, fixing both paths at once — this popup was never the app's actual
  keyboard-accessible surface anyway (that's `panels.js`'s own `trapFocus`,
  for the full details panel "Show more details" opens into), so turning
  off MapLibre's own focus grab here entirely is correct, not a workaround.
  If this class of bug shows up a third time, suspect a *third* MapLibre
  code path calling `_focusFirstElement()` before assuming the fix is
  wrong — grep the actual installed `node_modules/maplibre-gl` source for
  `_focusFirstElement`, don't re-derive its call sites from memory.
  **`formatAircraftInfo()`'s output is HTML-escaped** (`app.js`'s own
  `escapeHtml`, same pattern as `aircraft-panel.js`/`stats.js`) before
  going into `setHTML()` — `aircraft.flight`/`typeCode` ultimately come
  from readsb's `aircraft.json`, trusted when read from the local file,
  but `HttpSource` fetches the same JSON over plain, unauthenticated HTTP
  (the "dev on WSL against live data" mode above), where anyone else on
  the LAN can MITM/spoof the response — an unescaped callsign there was a
  real stored-XSS path into the browser's own Settings session. Found
  2026-07-31 during a security review, not reported live.
  **Redesigned 2026-07-31** after the popup was reported showing
  invisible (white-on-white) text — the actual bug turned out to be a
  backward CSS selector (`.mlpr-popup .maplibregl-popup-content`, which
  expects MapLibre's own content wrapper to be a *descendant* of our div,
  when MapLibre actually nests it the other way: our `.mlpr-popup` lives
  *inside* `.maplibregl-popup-content`) that had silently never matched
  anything, leaving the popup on MapLibre's default white background the
  whole time. Harmless-looking on its own, but combined with this file's
  `:root { color-scheme: dark }` (added later, for native checkboxes —
  see the Settings section), unstyled text with no explicit `color`
  resolves to a *light* default, genuinely invisible on that leftover
  white background rather than just off-brand. Fixed by styling
  `.maplibregl-popup-content` directly (this app only ever shows one kind
  of popup, so no extra scoping needed) instead of the broken nested
  selector, and used the opportunity to redesign the content itself to
  match the rest of the app's card language rather than just recoloring
  the old plain `<br>`-joined lines: a bold callsign header
  (`.mlpr-popup-callsign`) followed by a `.mlpr-popup-chips` row reusing
  aircraft-panel.js's exact chip markup (`.mlpr-detail-chip`/`-chip b`) —
  so the popup and the full details panel it opens into read as the same
  visual language, not two different ones — plus a `.mlpr-popup-badge`
  (the same green pill `.mlpr-detail-flag` uses for boolean tiles) for
  "on ground" specifically, since that's a standalone flag, not a value
  paired with a label the way Type/Altitude/Speed are. MapLibre's own
  popup tip (the triangle pointing at the aircraft) and close button are
  both hardcoded white/unstyled by MapLibre's own CSS and needed their
  own overrides too, matched per anchor direction
  (`.maplibregl-popup-anchor-{top,bottom,left,right}(-left/-right)
  .maplibregl-popup-tip`) since MapLibre auto-picks which corner to
  anchor the popup from depending on available screen space. Verified
  visually by reconstructing MapLibre's actual popup DOM (tip + content +
  close button wrapping our markup) against the real stylesheet, since
  this sandbox has no WebGL and `app.js` itself can't load far enough to
  open a real one (see the coverage-map section's note on this same
  limitation) — not by guessing that the CSS ought to work.
- **Aircraft icon shapes and classification** (`public/js/plane-icons.js` +
  `icon-classify.js`, wired into the live map 2026-07-29): 17 hand-drawn
  top-down silhouettes (`PLANE_ICON_IDS` — narrowbody/widebody2/3/4, light,
  bizjet, cargo_turboprop, cargo_jet, military_jet, special, helicopter,
  glider, balloon, drone, ground_vehicle, unknown, plus `tower` for
  typeCode `'TWR'` ground-station beacons, outside the 16-icon spec), each
  a single `<path fill="currentColor">` in a shared 24x24 viewBox so a
  marker can be recolored without touching its shape. `icon-classify.js`'s
  `classifyIconKind(aircraft)` picks one via a fixed-order chain (typeCode
  `'TWR'` → military-table override → own type table, `data/
  icon-types.json`, exact-then-longest-prefix → ADS-B `category` field →
  `'unknown'` fallback) — this algorithm is final; only the type table's
  real-world coverage is still growing (see `/dev/icon-types` and
  `/dev/icon_verify` below). `NON_ROTATING_ICON_IDS` (balloon/tower/drone —
  none of the three have a meaningful "nose direction": a balloon's basket
  hangs asymmetrically below the envelope, a ground beacon has no heading
  at all, a quadcopter has no fixed nose) must always render upright
  regardless of `track`. `public/js/aircraft-icon-live.js` is the
  production adapter `app.js` actually imports — it wraps
  `classifyIconKind`/`getIconPath` behind the same `createPlaneElement`/
  `setPlaneKind`/`setPlaneHeading`/`setPlaneColor`/`setPlaneLabel` shape an
  older, simpler 4-shape module (`aircraft-icon.js`) already had, so
  swapping the import was most of the work. That old module, its test
  file, and `/dev/icons`' own old-vs-new comparison row were all removed
  entirely once nothing referenced them anymore (2026-07-30) — the icon
  dev pages themselves (`/dev/icons`, `/dev/icons-map`, `/dev/icon-types`,
  `/dev/icon_verify`) stay, only the retired-module comparison went.
  `icon-types.json` is fetched once (`await loadIconTypes()`) inside
  `app.js`'s `map.on('load', ...)`, before the first queued snapshot is
  ever classified. A dev-only `/dev/icons` page exists for browsing every
  shape/rotation/size combination and a live classification-chain tester;
  `/dev/icon-types` (also dev-only) is a filterable table over every
  `icon-types.json` entry, flagging lower-confidence designators via the
  JSON's own `_needsVerification` field. `/dev/icon_verify` is different
  from both — **available in production** (not NODE_ENV-gated, since it
  needs a receiver's real accumulated traffic to be useful at all) — it
  runs every registration this install has actually seen
  (`GET /api/stats/registrations`) through the real classification chain,
  highlighting unresolved (`unknown`) results: the practical, ongoing way
  to find gaps in `icon-types.json` against this receiver's own traffic,
  in place of a separate offline verification script (considered, then
  deliberately not built — the live page does the same job better).
- **Icon size is user-adjustable** (`aircraftIconSize` in `settings-state.js`,
  default 40px, a Settings → Aircraft slider, range 24–64px) — applied via a
  CSS custom property (`--mlpr-plane-size`). `app.js`'s `applyIconSize` sets
  it at `documentElement` level as a cheap fallback/base value, but each
  marker also gets its own inline override
  (`aircraft-icon-live.js`'s `refreshMarkerSize`, an element's own inline
  custom-property value always wins over an inherited one) equal to the
  slider value times that icon kind's own multiplier
  (`plane-icons.js`'s `ICON_SIZE_MULTIPLIERS` — e.g. a widebody reads
  1.25x bigger, a drone 0.8x smaller — so scale differences between
  aircraft types are visible on the map itself, not just in the `/dev/icons`
  gallery). Refreshed on a kind change and whenever the slider itself
  changes (`app.js`'s `onSettingsChange`, looping every tracked marker same
  as it already does for color/label). The popup offset above is derived
  from the plain slider value, not the per-kind multiplier — a known,
  accepted imprecision for a scaled-up/down marker rather than something
  worth complicating the offset math over.
- **Marker color has three mutually-exclusive modes** (`planeColorMode` in
  `settings-state.js`, Settings → Aircraft, default `signalLoss`):
  `signalLoss` fades an aircraft from fresh green to stale red the longer it
  goes without an update (the only mode tied to elapsed time — the periodic
  redraw tick in `app.js` only recolors for staleness in this mode, since
  the other two are static per-update snapshots of a flight parameter and
  don't need it); `altitude` reuses trail.js's `colorForAltitude` directly
  (same gradient as trails, exported for this purpose); `speed` is a new
  green→yellow→orange→red gradient over ground speed in knots
  (`colorForSpeed` in `aircraft-color.js`), deliberately never touching
  blue/violet so it doesn't read as a variant of the altitude scale even
  though the two are never shown at once. `colorForElapsed` and
  `colorForSpeed` live in `public/js/aircraft-color.js`, not `app.js` —
  `app.js` instantiates `maplibregl.Map` at module scope and can't be
  loaded under plain `node --test`, so this pure color logic was pulled out
  specifically to keep it unit-testable (`aircraft-color.test.js`), the same
  reasoning as `aircraft-details.js` below. The HSL gradient math itself
  (`colorFromStops` and friends) lives in `public/js/color-gradient.js`,
  shared by both `trail.js`'s altitude gradient and `aircraft-color.js`'s
  speed gradient rather than duplicated a third time.

### Aircraft details panel (`public/js/aircraft-details.js` + `aircraft-panel.js`)

Split in two deliberately: `aircraft-details.js` is pure data-shaping (which
fields to show, in what order, formatted how) with **zero DOM/browser
dependency**, so it's testable with plain `node --test`
(`aircraft-details.test.js`) the same way the server code is — importing
`i18n.js` or `radar-state.js` at module scope would crash under plain Node
(`i18n.js` reads `navigator.language` at import time). `aircraft-panel.js`
does the actual DOM rendering, translation (`t()`), and the Planespotters
photo fetch, and is the piece wired into `panels.js`.

- Fields are tiered: `core` (always visible: identity, squawk, altitude,
  vertical rate, a speed cluster) and `extra` (behind a "show more
  fields" button: heading/attitude, autopilot/FMS targets, flags,
  weather, signal/reception, data-quality ballast, raw hex) — ordered
  roughly most-to-least interesting to a spotter, least-interesting
  (nic/rc/sil/gva/sda) at the very bottom.
- A field with no data for a given aircraft simply produces no tile —
  never a blank/dash placeholder.
- Related fields that should read as one group (e.g. `gs`/`ias`/`tas`/`mach`)
  are `cluster` entries: a labeled full-width row of inline chips, only the
  chips that have data.
- Two independent fields that should still sit side by side even when one
  is missing (e.g. altitude/vertical rate) share a `pairId`. Rendering
  (`aircraft-panel.js`'s `reorderForPairing`) matches pairs up explicitly
  and promotes an unpaired survivor to a full-width row — **don't rely on
  plain array adjacency for this**, it drifts as soon as an earlier tile in
  the list gets filtered out for a given aircraft (found and fixed during
  development: a missing `emergency` value shifted `altBaro` into squawk's
  slot and left `baroRate` stranded alone).
- Boolean flags (`military`/`interesting`/`pia`/`ladd`/`alert`/`spi`) only
  produce a tile when `true` — "not military" isn't worth a row.
- **Photo**: fetched client-side (never proxied through our server — see
  `THIRD_PARTY.md` for why that's a hard requirement of the API's terms) from
  Planespotters' free public Photo API, by ICAO hex. No photo, or the fetch
  failing, just means no photo section — never an error shown to the user.
  Headless/automated browsers get blocked by Cloudflare bot detection (hit
  this repeatedly verifying the feature during development — curl and
  headless Chromium both 403, a real/headed browser works fine); that's a
  property of automation, not of real users' browsers, so don't read a 403
  in a headless test as the integration being broken.
- The photo section and the tiles section are separate DOM subtrees updated
  independently: tiles redraw on every `radar-state.js` change (matching
  `list.js`'s existing pattern, imprecise but consistent with the rest of
  the app), but the photo is fetched exactly once per panel open — rebuilding
  it on every redraw would flicker/reload the image constantly.
- **`radar-state.js`'s aircraft mutators (`noteAircraft`/`removeAircraft`/
  `clearAircraft`) are deliberately silent** — they don't call `notify()`
  themselves. `app.js` applies a whole batch (every aircraft in one WS
  delta, or every hex swept in one forget-tick) and then calls
  `notifyAircraftChanged()` exactly once. This used to notify per-aircraft,
  which meant a delta touching dozens of aircraft rebuilt `list.js`'s entire
  `<table>` (and every other `onChange` listener) dozens of times a second —
  found and fixed as a real perf complaint (list flicker/scroll-reset under
  load), not a hypothetical one. Any new caller that mutates `liveAircraft`
  must remember to flush afterward, same as the two existing call sites in
  `app.js`; forgetting means listeners never find out, silently.
- Trail color follows altitude, smooth gradient: golden green at ground
  level, pure green by 10,000 ft, blue by 17,500 ft, then violet/magenta to
  red at 30,250 ft and dark red at 40,000 ft. Every leg (`ALTITUDE_STOPS` in
  `trail.js`) interpolates in HSL (`lerpSpace: 'hsl'`), deliberately: a
  plain RGB lerp between two colors of different hue *and* lightness passes
  through desaturated mud. That produced `rgb(92,57,83)` at a since-removed
  35,000 ft stop — typical cruise altitude, so most trails — a grey-maroon
  barely distinguishable from the grey no-contact color. Every altitude now
  stays above ~65% saturation while the gap grey sits at ~3%, which is what
  keeps "changed altitude" and "lost contact" visually separable. The
  0–10,000 ft leg exists specifically because that band used to be two
  identical greens (flat, no gradient at all) despite being where most
  locally-tracked traffic (circuit/approach/departure) spends its whole
  visible life — golden green at ground level is a **hue-only** shift (same
  lightness/saturation as the rest of the scale), not a darkened/muddy
  ground color. Pure red sits well above the blue stop (30,250 ft, not
  right after 17,500) on purpose, so cruise-altitude traffic (which is
  mostly 30–40k) gets a long, gradually-darkening red tail instead of
  collapsing into one indistinguishable dark red above ~30k. These exact
  stop values came from the user picking between several rendered
  side-by-side gradient comparisons — if asked to retune this again,
  generate comparison images the same way rather than guessing numbers.
  Regression tests in `trail.test.js` assert both the saturation floor and
  that a 3,000 ft step is a visibly different color — don't switch any leg
  back to plain RGB.
- Signal loss handling: no update for 3s → aircraft starts fading toward red;
  fully red by 10s, **stays fully red for another 10s** (found via real use —
  it was disappearing too abruptly), actually removed at 20s
  (`FADE_START_MS`/`FADE_END_MS`/`REMOVE_MS` in `app.js`). If it reappears,
  the trail segment between last contact and reappearance is drawn grey
  **and dashed** (`GAP_COLOR` in `trail.js` is a fixed neutral grey,
  deliberately identical in both map themes). After 5 minutes with no
  update, give up on it returning.
- **Map label under each aircraft** (`public/js/aircraft-icon-live.js`'s
  `setPlaneLabel`, built by `app.js`'s `buildAircraftLabel`): configurable
  per-field in Settings → Aircraft (`aircraftLabelFields` in
  `settings-state.js` — flight/hex, type, altitude, speed, default just
  flight/hex), so it stays as minimal as the user wants rather than
  cluttering the map by default. A field with no data for a given aircraft
  contributes nothing to the label (same "no tile, not a dash" philosophy as
  the aircraft details panel) rather than a placeholder; all-fields-off (or
  all-unavailable) collapses to an empty string, and `.mlpr-plane-label:empty`
  in `style.css` hides the pill entirely rather than showing an empty one.
  Rendered as a plain HTML div, a **sibling** of the `<svg>` inside
  `.mlpr-plane` (not inside it) — `setPlaneHeading` only rotates the `<svg>`,
  so the label never spins with the aircraft's heading, with no
  counter-rotation needed. Colors follow the **map's** resolved light/dark
  theme (`#map.mlpr-map-theme-light`/`-dark`, toggled in `app.js`'s
  `switchBasemap` against the *resolved* theme, not the raw `auto` setting),
  deliberately independent of the app's own always-dark UI theme, per
  explicit request. Hidden below `LABEL_MIN_ZOOM` (zoom 7) via one class
  toggle on the map container (`updateLabelZoomVisibility`) rather than
  touching every marker on every zoom tick — dozens of overlapping labels at
  a zoomed-out view is pure noise, not useful.
- **Selection and hover are visually distinct effects, on every axis, from
  each other and from the plane-color modes.** Requested explicitly: with
  many aircraft on screen, you need to keep track of "which one is this"
  without it depending on color, since color is already spoken for by
  `planeColorMode` (signal loss/altitude/speed).
  - **Selected** (`.mlpr-plane-selected`, toggled in `app.js`'s
    `setSelectionHighlight`, called from `selectAircraft`/
    `deselectAircraft`): a soft, breathing, **achromatic** halo
    (`.mlpr-plane-glow`, a background `div` sibling of `<svg>` placed
    *before* it in `aircraft-icon-live.js`'s markup so it paints behind —
    plain DOM order, no `z-index` needed) — white on the dark map theme,
    black on light, via the same `#map.mlpr-map-theme-*` classes the
    label uses. A background glow (not a filter on the icon) because
    animating `opacity`/`transform` on a plain element is far more
    reliably smooth across browsers than animating `filter` parameters,
    which is what hover uses instead (see below) — deliberately a
    *different technique*, not just a different color, so the two never
    read as variations on one effect even when both apply to the same
    aircraft at once (hovering the currently-selected one). Persistent
    until explicitly moved/cleared, since markers persist across updates.
  - **Hovered** (`.mlpr-plane-hover`): a crisp amber `drop-shadow` ring
    traced on the `<svg>`'s own silhouette (not a bounding box), not
    animated. Amber because it's not used anywhere else in the app's
    palette (trail gradient, speed gradient, plane-color modes). **Two-way
    cross-highlight** between the map and the List panel, each direction
    using a deliberately different mechanism to avoid two different perf
    pitfalls:
    - *Map → List*: a marker's own `mouseenter`/`mouseleave` (added once,
      alongside its `click` listener, when the marker is first created in
      `applyAircraftUpdate`) call `radar-state.js`'s `setHoveredHex`/
      broadcast it via a **separate** `onHoverChange` listener set, kept
      deliberately apart from the main `notify()`/`onChange` channel
      shared with aircraft-data updates. Routing hover through that
      channel would mean every mouse movement across a cluster of
      aircraft rebuilds `list.js`'s entire `<table>` — reintroducing the
      exact redraw-storm problem the earlier `notifyAircraftChanged()`
      batching fix (see below) exists to prevent, just triggered by mouse
      movement instead of WS deltas. `list.js`'s `updateHoverHighlight()`
      only toggles a class on already-rendered `<tr>` elements (matched
      via a `data-hex` attribute set in `drawTable()`), never rebuilds.
    - *List → Map*: a row's own `mouseenter`/`mouseleave` call
      `requestHover(hex | null)`, a direct request/handler pair (same
      shape as `setSelectRequestHandler`/`requestSelect`) rather than
      routed through broadcast state — there's exactly one map, so one
      global handler (registered once in `app.js`, tracking
      `lastHoverRequestHex` to know what to clear) is simpler than making
      this stateful just to immediately consume it.
- **Trails are always on**, with `trailMode` (Settings → Map) choosing
  `click` (only the selected aircraft, default) or `all` (every aircraft's
  trail drawn simultaneously, colors included). There used to be a separate
  `trailsEnabled` on/off checkbox above the mode; it was removed on request
  as redundant UI, so there is deliberately **no** way to turn trails off
  entirely any more — if that's ever wanted back, it should be a third
  `trailMode` value (`off`), not a second setting to keep in sync. The grey
  signal-loss segment and the altitude-colored segments are the *same*
  per-hex feature list (`public/js/trail.js`, entries carry an `isGap` flag)
  rendered into one shared `mlpr-trail` GeoJSON source. That single source
  feeds **two** layers — `mlpr-trail` (solid, `isGap != true`) and
  `mlpr-trail-gap` (dashed, `isGap == true`) — which is forced by MapLibre:
  `line-dasharray` is not data-driven, so "dashed only for gaps" can't be an
  expression on one layer. Two *layers* over the shared source is fine; what
  must never come back is a separate always-populated gap **source**, which
  is what once drew grey trails for unselected aircraft that never cleared.
- **Trail geometry is built as merged per-color runs**, not one 2-point
  LineString per sample (`trailFeaturesFor`). Altitude is quantised into
  200 ft bands (`ALTITUDE_BAND_FT`) purely so consecutive samples at a
  steady altitude produce an identical color string and collapse into a
  single polyline — at cruise that's the whole trail in one feature. This
  plus `line-cap: round` is the fix for "the trail looks dashed when zoomed
  out": each feature boundary is a seam that antialiasing renders as a
  hairline once a segment is only a few pixels long, and there used to be
  one seam per second of flight. `tolerance: 0` on the source (disabling
  geojson-vt simplification) is still needed as well — the two address
  different halves of the same symptom, don't remove either.
- **MLAT-derived trail points get anomaly-filtered and smoothed; ADS-B
  points never do** (2026-07-28, `public/js/trail.js`'s
  `filterMlatAnomalies`/`smoothMlatPositions`, both applied inside
  `trailFeaturesFor` — so both the server-seeded history and points
  recorded live from WS deltas get the same treatment, without duplicating
  the logic server-side too). MLAT positions are computed from several
  receivers' message timing rather than broadcast directly, so they can
  jump in ways a real aircraft never would (jagged zigzags, false sharp
  turns), especially with weak receiver geometry. Every point carries an
  `isMlat` flag now (`sourceType === 'mlat'`, threaded through all the way
  from `index.js`'s `recordPosition` call — the server-side ring buffer
  stores `sourceType` per point purely so a freshly-opened tab's *seeded*
  history can also be classified, not just points arriving live).
  `filterMlatAnomalies` is a single oldest-to-newest streaming pass: an
  ADS-B point (or a gap marker) is always kept and becomes the new
  reference; an MLAT point is judged against the two most recent *accepted*
  points (not just the raw previous one, so a run of several bad samples in
  a row doesn't each get compared against an already-rejected neighbor) and
  dropped outright — never just flagged — if it implies either an
  unrealistic speed (`MLAT_MAX_SPEED_KMH`, ~1200 kt, deliberately generous,
  only catches genuine multi-hundred-km jumps) or an unrealistic turn rate
  (`MLAT_MAX_TURN_RATE_DEG_PER_SEC`, 10°/s — a "standard rate" airliner turn
  is ~3°/s, even a hard fighter break is well under this). The turn-rate
  check is skipped entirely when either leg is shorter than
  `MLAT_MIN_TURN_CHECK_KM` (300 m) — GPS/MLAT-scale positional noise alone
  can imply a huge bearing swing between two points that close together,
  which isn't a real "turn" to reject. `smoothMlatPositions` runs second,
  over whatever survives filtering: a simple weighted 3-point moving
  average (`prev + 2×point + next` / 4) that only ever *moves* an MLAT
  point — ADS-B points are read as trustworthy anchors for an adjacent
  MLAT point's average but are never themselves modified, and an MLAT point
  at a trail's start/end or next to a gap (only one real neighbor) is left
  alone rather than half-averaged. Both passes are cheap no-ops on an
  all-ADS-B trail (the common case), so there's no need to gate them on
  whether MLAT is actually present.
- **Trail history is server-side** (`server/src/trail-history.js`), not just
  accumulated in the browser tab: an in-memory (never SQLite — hard rule 4 is
  about exactly this, raw position history) capped ring buffer per hex,
  recorded every poll tick alongside `state.js`, evicted when a hex leaves
  `state.js`'s tracked set. `GET /api/trails/:hex` and `GET /api/trails`
  (bulk, for "all" mode) let a freshly-opened tab show a meaningful trail
  immediately on click/select, not just from the moment that tab connected.
  The client (`trail.js`) seeds from these endpoints then keeps extending the
  trail live from ongoing WS deltas.
- Right-click-drag map rotate/tilt is disabled
  (`map.dragRotate.disable()` / `map.touchZoomRotate.disableRotation()`) —
  the radar stays permanently north-up and flat, per explicit request.

### Settings scope: per-browser vs. shared (load-bearing)

The Settings panel has five tabs, and **which tab something lives on encodes
where it is stored**. Don't add a setting to a tab without checking it lands
on the right side of this line:

| Tab | Contents | Stored |
|---|---|---|
| General | units, language | `localStorage` |
| Map | basemap mode, map theme, trails | `localStorage` |
| Aircraft | marker color mode, icon size, altitude filter | `localStorage` |
| Notifications | notification rules, ntfy topic, watch list, *smart home* | SQLite (shared) |
| Server | Settings password, server port, *receiver location* | SQLite (shared) |

**Smart Home was its own sixth tab until 2026-08-01**, when it was folded
into Notifications. The tab row is sized for five (`.mlpr-settings-tabs`
falls back to horizontal scrolling beyond that), so the sixth had been
quietly overflowing it. The merged tab shows the rule toggles ("what do I
want to be notified about") plus two buttons — **Configure notifications**
(ntfy topic, watch list) and **Configure smart home** (MQTT broker) — each
opening a subview that replaces the toggles in place, with a Back button
(`settings.js`'s `wireNotificationSubviews`). Deliberately *not* list.js's
floating-window machinery: that exists because List's Configure must sit
beside a live-updating table without disturbing it, and nothing here
updates while you're editing, so an in-place swap is both simpler and
identical on mobile and desktop. **The access-control split is unchanged
and is the thing to be careful about when touching this**: smart home
still does its own `passwordSet && !getStoredToken()` check inside
`renderSmartHomeTab` (broker credentials are a real infrastructure
secret), while the rule toggles, ntfy topic and watch list stay
deliberately ungated. Sharing a tab must not become sharing a gate.

- **Per-browser** settings live in `public/js/settings-state.js`
  (`localStorage`), so each person/device gets their own units, map look and
  aircraft display without affecting anyone else on the LAN.
- **Shared** settings live server-side in SQLite and are reached over
  `/api/*`. Notification rules and the watch list were already server-side;
  the Server tab's password, port, and receiver location join them there.
- **The receiver location lives on the Server tab, not Map**, even though it
  feels map-related — it describes one physical antenna (no sensible
  per-browser answer to "where is the receiver"), and moving it in with the
  other server-level, password-gated controls (see "Settings access
  control" below) meant it no longer needed a one-off exception note on the
  Map tab. Each tab still carries a `.mlpr-scope-note` banner saying whether
  it's per-browser or shared — keep that accurate if anything moves again.

**Server port** (`server/src/server-config.js`): resolution order is
`MLPR_PORT` env > stored config > 1090, and `GET /api/server/port` reports
which of the three is in effect so the UI can say "currently overridden by
MLPR_PORT" instead of showing a field that silently does nothing. Changing
it persists the value but **does not rebind the running server** — the
systemd unit is `Restart=on-failure`, so exiting to pick up a new port would
just stop the service rather than restart it; the UI tells the user to
restart manually. `validatePort` rejects anything below 1024 (would need
root, which MLPR never runs as), readsb's own ports, and 8080/8085 — a UI
that could bind over readsb's ports would break the very receiver MLPR reads
from. Saving asks for confirmation first (`window.confirm` — a deliberately
heavier gate than the inline status messages everywhere else, since
mistyping a port on a headless Pi is an easy way to lock yourself out): the
message states the *exact* new address (`location.protocol`/
`location.hostname` — the host the browser is already on, unchanged — plus
the new port), not a vague "somewhere else" warning. The config backup
restore button (see below) uses the same `window.confirm` gate for the
same reason — restoring an old backup is just as easy a way to lock
yourself out (a stale password, a stale port).

**Config backup/restore** (`server/src/config-backup.js`, Server tab's
"Backup" fieldset): a full export/import of everything in SQLite's
`config` table — notification settings, watch list, smart-home broker
settings, ntfy topic, receiver home location, server port, and the
Settings password hash — in one JSON file. Added because hard rule 4
already keeps this table small, but nothing protected it from an outright
SD card failure; there was no way to get it back except retyping it by
hand. Deliberately generic over the table's mix of raw-string and
JSON-blob values (`db.js`'s `getAllConfigEntries`) — export/import treat
every value as an opaque string and round-trip it byte-for-byte, so the
module doesn't need updating every time a new config key is added
elsewhere. Import **merges** into the existing config (only overwrites
keys actually present in the file) rather than wiping the table first, so
restoring an export taken on an older MLPR version can't delete a
newer-version-only setting it never knew about. `GET`/`POST
/api/settings/export`/`/import`, both gated behind `requireSettingsAuth`
— a deliberate exception to that gate's usual scope (notification
settings/watch list are normally ungated): the export bundles them
*alongside* the password hash and smart-home credentials in one payload,
so the combined response has to be protected at the level of its most
sensitive content. A successful import calls `reconfigureSmartHome()`
immediately (same "apply without a restart" behavior the smart-home PUT
route already has) and the frontend just says "reload the page" afterward
rather than trying to live-refresh every affected UI section individually.

## Notification engine

Implemented (Stage 5) in `server/src/notifications/`: `rules.js` (evaluation),
`cooldown.js` (per-`${ruleType}:${hex}` in-memory cooldown, default 30 min),
`ntfy.js` (delivery), `settings.js` (enabled/disabled rules + the ntfy topic,
persisted in the SQLite `config` table — see `db.js`'s JSON config helpers).

Live triggers: squawk 7500/7600/7700, first-time-seen aircraft (checked
against the `seen_aircraft` table — grows for the life of the install, bounded
by distinct aircraft ever seen, not a "position history" table so it's fine
under hard rule 4) **delayed by `FIRST_SEEN_DELAY_MS` (3s, a few poll ticks)**
before it actually notifies or writes to `seen_aircraft` — readsb can take a
tick or two to decode an aircraft's callsign/position after first hearing its
Mode-S address, and firing immediately produced notifications like "c48e893"
or "4892c6 · 484 kt" with fields still missing (reported live, 2026-07-27;
fixed 2026-07-28). `rules.js`'s in-memory `pendingFirstSeen` map (hex → first-
noticed timestamp, same shape as `cooldown.js`'s `lastNotifiedAt`, pruned on
the same hourly interval via `prunePendingFirstSeen`) tracks this; a hex that
never gets a second look within the delay (a one-off Mode-S blip) simply never
notifies and is never written to `seen_aircraft` either — arguably more
correct than the old immediate-fire behavior, since we never actually got a
good-enough look at it. `evaluateAircraftRules` takes an optional second `now`
argument (defaults to the real clock) purely so tests can exercise the delay
deterministically without real waits or fake timers; the one real call site
(`index.js`) never passes it. New all-time range record (compared against an
`allTimeMaxRangeKm` config value) — **fed by MLPR's own per-tick Haversine
calc since 2026-08-01** (`bestRangeKm`, `index.js`'s
`recordRangeAndRegistrationSightings`, `range.js`'s `distanceKm`,
MLAT-excluded via `isRangeEligible`), not readsb's own `stats.json`
`total.max_distance` as originally shipped — see the "Range/position
sampling" section below for why the switch happened (a real, live
inversion: "today"'s max range briefly exceeded "all time"'s, since the two
were computed by two independent, differently-filtered mechanisms), and a
**watch list**
(`watchlist.js`): entries `{id, matchType: type|registration|flight,
matchValue, altitudeOperator: below|above|null, altitudeValue, area}`,
stored as JSON in `config` (same pattern as notification settings). Matching
is case-insensitive on `aircraft[typeCode|registration|flight]`; the altitude
condition treats `onGround` as altitude 0, and simply doesn't match if the
needed altitude data isn't available (never a false positive from missing
data). Each rule respects its own enabled/disabled toggle from Settings
(the watch list's own `watchedEnabled` was added 2026-08-01 — it was the
one rule with no toggle, which read as an omission once the merged
Notifications tab listed them all side by side); **squawk and watch-list
both have a per-hex cooldown** (first-seen and range-record are naturally
one-shot per hex/record already).

**Receiver-silence watchdog** (`evaluateReceiverSilenceRule`, added
2026-08-02) is a different shape of rule from every other one in this
file: the others all fire on the *presence* of some condition on an
aircraft; this fires on the *absence* of any aircraft at all — a receiver
health check, not an aircraft-tracking one. `index.js`'s `pollOnce` calls
it once per poll tick with a single boolean, computed **before** the
existing `raw === null` early-return so a completely failed fetch counts
too: `Array.isArray(raw?.aircraft) && raw.aircraft.length > 0`.
"Activity" deliberately means **at least one tracked hex, position or
not** — a Mode-S-only contact still proves the receiver and readsb are
both alive, so requiring a position would both miss the point (a dead
antenna produces zero hexes of any kind, not just zero positioned ones)
and false-alarm in weak-MLAT areas. Threshold is a flat **1 hour**
(`RECEIVER_SILENCE_MS`), not exposed as a setting — deliberately changed
from the 5 minutes floated when this was first proposed (`TODO.md`,
2026-07-28): the user pointed out 5 minutes is well within a normal
quiet-traffic gap, especially overnight in a low-traffic area, and would
have been a real false-alarm source, not a hypothetical one. State
(`lastActivityAt`, seeded to the process's own start time so a fresh boot
doesn't count time-since-epoch as an unbroken outage; `receiverSilenceNotified`,
a latch so a multi-hour outage notifies once, not once per tick) is
in-memory only, same "fine to lose on restart" reasoning as
`pendingFirstSeen`/`cooldown.js` (hard rule 6) — a restart resets the
countdown, which reads as "the receiver just came back", a reasonable
thing to believe right after a restart anyway. The latch is set
regardless of the `receiverSilenceEnabled` toggle (only whether `notify()`
actually runs depends on it), so toggling the setting off and back on
mid-outage doesn't immediately re-fire, and a disabled rule doesn't keep
doing per-tick work once it already knows the answer for this outage.
ntfy-only (no smart-home/MQTT publish) — same scope decision as the
range-record rule, which is the other rule this was explicitly modelled
on ("like the range-record notification, in the Notifications tab, with
its own enable/disable toggle").

**Fixed alongside this**: `server.js`'s `PUT /api/notifications/settings`
validated-key whitelist was missing `watchedEnabled` entirely — the
Notifications tab's "Watched aircraft" checkbox has called the endpoint
with it since that toggle was added (2026-08-01), but the value was
silently dropped before ever reaching `updateNotificationSettings`, so the
checkbox had no effect. Found while adding `receiverSilenceEnabled` to
that same list, not reported live.

**Trigger area** (`area`, optional, added 2026-08-01): `{kind: 'circle',
lat, lon, radiusKm}`, `{kind: 'rectangle', lat, lon, widthKm, heightKm}`,
`{kind: 'polygon', lat, lon, points: [{lat, lon}, ...]}` (added
2026-08-02), or `null`. Matched by `rules.js`'s `satisfiesAreaCondition` — area and
altitude must **both** hold, and an aircraft with no position never matches
an area-restricted entry (same "missing data is never a false positive"
rule as altitude). An *unrecognised* `kind` also matches nothing rather
than everything: an over-firing rule is worse than a silent one, and this
is what an entry written by a newer version then read back after a
downgrade looks like. The `kind` discriminator exists so more shapes can be
added without migrating stored entries -- all three shapes now exist.

**Every shape is centre-anchored** (`lat`/`lon` plus its own size fields)
rather than corner- or vertex-based — it keeps "drag the middle to move the
whole thing" uniform, and matches the editor's centre pin. Shape-specific
knowledge lives in exactly three per-shape tables so adding one touches
little else: `watchlist.js`'s `AREA_SIZE_FIELDS` (which size fields exist,
driving both validation and the field-stripping in `normalizeArea` — a
rectangle must not carry a stray `radiusKm`, or `rules.js` would have two
plausible but conflicting sources of size), `area-editor.js`'s
`HANDLE_SPECS` (where each resize handle sits and what it edits), and
`geo.js`'s ring builders behind `shapeRing` (so the two map layers never
learn which shape they're drawing). Polygon opts out of `HANDLE_SPECS`
entirely: its handles are the vertices, built by `addVertexMarkers`.

**The rectangle's bounds are derived with the same `destinationPoint()`
calls on both sides** — `rules.js` for matching, `geo.js`'s
`rectangleEdges`/`rectangleRing` for drawing — so "inside the box on
screen" and "matches the rule" cannot drift apart. Only four corners are
needed despite the circle using 128 points: a lat/lon-aligned box is a true
rectangle in Web Mercator (constant latitude renders horizontal, constant
longitude vertical), so subdividing would add vertices that all land on the
straight lines already drawn between the corners. The longitude test
handles a box straddling the antimeridian (`west > east`) — vanishingly
unlikely for a home receiver, but getting it wrong would silently invert
the test rather than fail loudly. Dragging a rectangle handle moves *both*
opposite edges (the handle sits half a dimension from the centre, so
`valueFromDrag` doubles it), keeping the box centred rather than stretching
one side.

**The centre is an arbitrary point, deliberately NOT the receiver's home**
— the driving use case (explicit, 2026-08-01) is watching a *specific piece
of sky that isn't overhead*: an airfield or approach path some km away.
Nothing in the matching path reads `home.js` at all. `radiusKm` is the
canonical stored unit regardless of the user's display preference, same as
every other distance the server persists.

Drawn in a full-screen map editor (`public/js/area-editor.js`,
`#area-editor` in `index.html`) opened from the watch-list form. It's its
own top-level element rather than a `FULLSCREEN_MODALS` entry because it's
*parameterised* (it edits an area handed in) and *resolves a value back*
(area / `null` = cleared / `undefined` = cancelled — the caller genuinely
has to tell "cleared" from "cancelled" apart), which that registry's
`render(el)` contract has no room for. It runs its own short-lived
MapLibre instance; `basemap.js`'s `styleForSecondaryMap` gives it the
user's configured basemap **without** touching `applyBasemapMode`'s
module-level fallback state, which is scoped to the one long-lived main map
(pointing that function at a second map would let a transient editor map
overwrite the callbacks the main map's own error watcher fires with).
Circle geometry reuses `geo.js`'s `destinationPoint`/`circleRing` (a
globe circle is not a screen circle, so it's drawn as a polygon of points
all exactly `radiusKm` out). The centre pin and every resize handle are
plain draggable `maplibregl.Marker`s — dragging the pin moves the whole
shape (size fields untouched, handles simply recomputed from the new
centre), dragging a handle sets one size field. For the circle the drag's
bearing is ignored (a circle has no orientation) and the handle snaps back
due east on `dragend`. Each readout/input lives *in its own handle's
element* so the number sits next to what you're dragging; the `<input>`
stops `pointerdown` propagating so clicking into the field to type doesn't
also start a drag. **The handle element is deliberately 0×0** with the dot
absolutely centred on it: MapLibre centres a marker's whole element on its
coordinate, so with the readout box in normal flow the element's centre
landed inside that box and the dot sat visibly *inside* the shape instead
of on its outline (reported live). At 0×0 the centring is a no-op, and the
readout can grow (a 4-digit size, a longer unit) without ever moving the
anchor again.

**How each shape is created differs, deliberately**: a circle is
click-to-place (its toolbar button just arms that mode); a rectangle and a
polygon both appear immediately at the map centre the moment their button
is pressed (explicit spec — there is no placing step). A fresh polygon is a
**hexagon**, chosen so it already reads as "reshape me" rather than as a
finished shape, and so several vertices can be removed before hitting the
three-point floor.

**Polygon editing** (all explicit spec, 2026-08-02): drag a vertex to move
it; **tap an edge** to insert a vertex there; **double-tap/double-click a
vertex** to remove it; on desktop, **right-click a vertex** for a menu with
the same removal, shown *disabled* at the three-vertex floor so the reason
is visible rather than the gesture silently doing nothing. Edge insertion
is hit-tested in **screen space** (`map.project`, `EDGE_HIT_TOLERANCE_PX`)
rather than lat/lon: the question is "did they click near that line", which
is about what they see — a lat/lon threshold would make edges progressively
harder to hit the further north you are. The new vertex lands on the
closest point *of the edge*, not where the finger was, so the outline
doesn't jump. **Double-tap is detected by hand, from consecutive `pointerdown`s -- never
the native `dblclick`.** A draggable MapLibre marker cannot reliably
produce one: `Marker._onMove` sets `element.style.pointerEvents = 'none'`
the moment the pointer drifts past `clickTolerance` (3px), deliberately, to
"suppress click event so that popups don't toggle on drag", restoring it
only on mouseup. A few pixels of drift while double-clicking a small dot is
normal, so `click` -- and therefore `dblclick` -- never reaches the
element. `pointerdown` always does, and covers mouse and touch in one path.
A press that followed an actual drag is excluded, so nudging a vertex and
immediately regrabbing it doesn't delete it — but **"an actual drag" must be
measured, not taken from MapLibre's `dragstart`**, and that distinction is
the whole of the phone-only follow-up bug (reported 2026-08-02: removal
worked on a PC, never on a touchscreen). A `Marker` starts dragging after
3px of movement (`clickTolerance`, defaulted from the map), and a fingertip
practically never holds a 16px dot to within 3px, so on touch *every* tap
fired `dragstart` and disqualified the next press from ever completing the
pair. A mouse click usually doesn't move at all, which is exactly why it
looked fine on desktop. The `drag` handler now sets the flag itself, only
once the vertex has travelled `TAP_DRIFT_PX` (12) in **screen pixels**
(`map.project`, measured from the vertex's own position at `pointerdown`,
not the pointer's — `map.project`'s origin is the canvas, not the viewport)
— the same "did they mean it" question the user actually sees, at any zoom.
The tap window/slop were widened at the same time (450ms / 32px) for a
finger rather than a mouse. **The map's own double-tap zoom has to be muted
separately** (`suppressTapZoom`, `TAP_ZOOM_MUTE_MS`): the `dblclick`
listener on each vertex only blocks the *mouse* half, while on touch
MapLibre's `TapZoomHandler` answers the same gesture off touchstart/touchend
bubbling to the canvas container — so a removal would also zoom the map out
from under the finger. Stopping those events from bubbling is not an option:
`Marker._addDragHandler` is registered as `map.on('touchstart')` and
listens for the very same bubbled event, so blocking them kills vertex
dragging outright. Disabling `map.doubleClickZoom` for the rest of the
gesture (re-enabled on a timer) leaves dragging alone. It is muted *before*
`removeVertex`, so a removal refused at the three-vertex floor doesn't leave
a zoom as the gesture's only visible answer. **`event.button` is not
checked** -- either mouse button counts, and so does a mixed pair (explicit
request). That is also why the right-click menu is offset off the pointer
rather than flush to it: sitting under the click position it would swallow
the second press of a right-button double-click. The `dblclick` listener that
remains only suppresses the map's double-click zoom. (Read out of the
installed maplibre-gl source, not re-derived -- same discipline the popup
focus bug needed.)

**The vertex dot must be a real child element, not a `::after`.** A
pseudo-element is painted but generates no hit-test target, so on the 0x0
marker root `document.elementFromPoint()` over the dot returns `null`:
nothing is clickable, and MapLibre's drag handler -- gated on
`element.contains(event.target)` -- never recognises the marker either, so
the vertex can't be dragged at all. `.mlpr-area-handle-dot` (circle/
rectangle) had this right already; the polygon vertex broke from that
pattern and had to be brought back. Both bugs surfaced together as one
report ("double-click doesn't remove a vertex on PC", 2026-08-02) and the
original test missed both by dispatching a synthetic `dblclick`, which
bypasses hit-testing and the pointer-events mechanism alike -- verify this
kind of interaction with real pointer input.

**Touch removes a vertex by long press (`LONG_PRESS_MS`, 450ms); the
right-click menu is desktop-only** (2026-08-02, explicit request). On a
phone that menu had exactly one item, so it was a menu for the sake of
being one — the press itself now does the removal, and the `contextmenu`
handler's only remaining job on touch is keeping the *native* menu off the
screen (mobile browsers raise one at ~500ms, which is why our deadline sits
just under it). Whether a press is touch is read from the last
`pointerdown`'s `pointerType`, not from the `contextmenu` event, which is
still a plain `MouseEvent` outside very recent Chrome. A press only stops
being a long press once the vertex has actually moved `TAP_DRIFT_PX` —
reusing the same measured threshold the double-tap fix needed, for the same
reason: MapLibre's own `dragstart` fires at 3px, which a fingertip crosses
while holding still.

**A gesture that removes a vertex also mutes the map click that follows it**
(`MAP_CLICK_MUTE_MS`). The press that completes a double-tap or a long press
is still turned into a click on the map underneath, landing exactly where
the vertex used to be — i.e. right by the edge that just closed over it — so
the same gesture could insert a vertex straight back. Related, and the
reason `map.on('click')` also ignores clicks whose `originalEvent.target`
sits inside a marker element: markers are DOM children of the canvas
container, so a click on one arrives at the map handler like any other, and
a vertex is an endpoint of two edges, matching the insert hit-test at
distance 0 every time.

**The back gesture closes the editor and only the editor**
(`public/js/history-overlay.js`, 2026-08-02). The editor is a top-level
overlay opened from *inside* the Settings panel, so it can't reuse
`panels.js`'s single "a panel or modal is open" history entry — it stacks a
second one on top and registers what a pop should do; `panels.js`'s
`popstate` listener gives that overlay first refusal before closing anything
of its own. Closing by any other route (Save/Cancel/Escape) consumes the
entry itself, and the `popstate` that `history.back()` then fires is
swallowed — without that flag it falls through to `panels.js` and closes the
Settings panel underneath, the same trap that file already documents for its
own panel/modal split. Its own module rather than an export from `panels.js`
purely to avoid the import cycle (`panels.js` → `settings.js` →
`area-editor.js`). Unit-tested against a stubbed global `history`
(`history-overlay.test.js`) — no DOM needed, and the swallow flag is exactly
the kind of thing worth pinning down.

**"Clear area" clears the shape and stays open** (2026-08-02, was on
`TODO.md`) — it used to call `close(null)`, i.e. behave as a second Cancel.
It also resets the shape selector to circle rather than leaving, say,
"polygon" active with nothing drawn: an already-active shape button ignores
its own click, so that state would leave no way to draw anything again.
Saving with nothing drawn is still how an area gets removed from an entry,
so the caller's cleared (`null`) / cancelled (`undefined`) distinction is
untouched.

A self-intersecting polygon is allowed rather than rejected: the server's
even-odd ray casting gives a defined, stable answer for one (the lobes
alternate), and refusing to let a vertex cross another would be more
surprising than honouring it. The hint strip carries the standing
instruction while a polygon is being edited, and doubles as transient
feedback when a removal is refused. Switching shapes *clears* the
current one rather than converting it: the shapes have no meaningful common
size, and guessing one would quietly change an area the user had already
tuned. `syncShapeButtons` also hides the "tap the map" hint whenever it
wouldn't do anything (i.e. anything but an empty circle).

A `try/catch` around the `Map` constructor closes the editor cleanly if
WebGL is unavailable — otherwise the promise would reject with the overlay
still on screen and no way out. Note this also means **the editor cannot be
inspected in the WebGL-less sandbox at all** (it correctly closes itself on
open); verifying anything in it needs the route-intercept FakeMap/FakeMarker
stub technique described in the coverage-map section.

**Delivery**: ntfy.sh (public instance), using its **JSON publish API** (POST
to `https://ntfy.sh/` with `{topic, title, message, priority, tags}` as the
body) — not the header-based API, which breaks on non-ASCII content.
`priority` must be a **number 1–5**, not the string values ("default" etc.)
the header API accepts.

**Message content** (`rules.js`'s `aircraftLabel`): flight/hex, registration,
type code, altitude (or "ground"), speed — in that order, each omitted when
not available. The notification's **title** already carries the reason
(squawk code + meaning, "First time seen", "Watched aircraft"), so the
message body doesn't repeat it.

**Click-to-open** (`ntfy.js`): ntfy's JSON API supports a `click` URL,
opened when the notification is tapped on whatever device receives it
(typically the user's phone) — so it must be a LAN address reachable from
there, never `localhost` (which would mean the phone itself). Auto-detected
once at startup via `os.networkInterfaces()` (first non-internal IPv4); on
a Pi with one NIC that's always correct. Best-effort by design — if it ever
picks the wrong interface, tapping the notification just does nothing
useful, which was explicitly signed off as an acceptable trade-off for a
"nice to have, skip if it can't be done cleanly" feature.

**ntfy topic**: an 8-character random string, auto-generated on first use and
persisted in `config`, shown in Settings with "install ntfy, enter this as
the topic." Regenerable. The charset deliberately excludes `0/o` and `1/l/i`
(found via a real user mistyping a code that had one) — don't add them back.
Never hardcode or log a real topic value anywhere persistent — whoever knows
it can read the notifications.

Deferred to later (see `TODO.md`): a general radius-from-home geofence
(independent of the watch list — "notify for *any* aircraft entering this
radius", not just watched ones). Web Push is deferred for good (needs a
secure context, awkward over plain HTTP on a LAN). ntfy is the only *push*
delivery channel — see the next section for a second, independent channel
(MQTT/smart-home) that exists alongside it, not instead of it.

**Known rough edge**: on a fresh install (empty `seen_aircraft` table), every
aircraft currently in range will fire a "first seen" notification. Not fixed
— mention it if the user is surprised by a notification burst right after
first setup.

## Smart home / MQTT integration

Implemented 2026-07-29, tested against Home Assistant. A **third**,
independent notification channel alongside ntfy (not a generalization of
it): ntfy wants a human-readable `title`/`message` for a push notification,
this wants a machine-readable JSON event for a home-automation rule engine
to act on — e.g. dim the lights and change their color when a watched
aircraft type (a landing A380, say) is picked up nearby. Originally wired to only two of `rules.js`'s four notification rules —
first-seen and watch-list matches, not squawk emergencies or range
records — an explicit scope decision (not an oversight) made when this was
speced. **Squawk 7500/7600/7700 joined them 2026-08-01** — exactly the
"one more `publishSmartHomeEvent()` call site in `rules.js`" this section
used to anticipate, in the same cooldown-gated block as the existing ntfy
squawk notification. The payload adds `squawk`/`squawkMeaning` (the human-
readable Hijack/Radio failure/Emergency text, so an HA automation doesn't
need its own copy of `SQUAWK_MEANINGS`) on top of the usual aircraft
fields. Range records remain the one rule still deliberately out of scope
(a single pre-aggregated all-time number, not a discrete per-aircraft
occurrence the way the other three are).

**Hand-rolled MQTT client (`server/src/notifications/mqtt-client.js`), not
the `mqtt` npm package** — deliberated explicitly with the user before
building. A *full* MQTT client (QoS 1/2 ack tracking, subscriptions, MQTT 5,
WebSocket transport) is genuinely more than "a few dozen lines" and would
justify a dependency; but MLPR only ever needs to **publish, QoS 0,
fire-and-forget** (losing one event because the broker was briefly
unreachable is an acceptable failure mode — the same trade-off already made
for ntfy delivery), which cuts out most of the protocol's real complexity
(no packet-ID tracking, no ack/retry state machine, no subscribe path at
all). That narrower subset is ~250 lines over Node's built-in `net`/`tls`
(so `mqtts://` is free — same framing, different socket constructor) and is
exactly the kind of thing this codebase already prefers to hand-write over
adding a dependency (see the OpenFlights CSV parser, the sunrise-equation
daylight code, hand-rolled chart rendering). Verified two ways:
`mqtt-client.test.js` unit-tests packet encoding against known byte
sequences from the spec, plus an in-process fake TCP broker with its own,
independently-written decoder (deliberately not reusing the client's own
encode/decode helpers, so a shared bug can't hide from the test) exercising
a real `connect()` → `publish()` round trip. What's deliberately **not**
implemented, because nothing here needs it: QoS 1/2, subscribing, MQTT 5,
WebSocket transport.

**`connectTimeoutMs`** (constructor option, default 10s): guards the whole
path from opening the socket to a successful CONNACK, cleared only on
CONNACK (not the plain TCP `'connect'` event) since a broker that accepts
the TCP handshake but never actually answers the MQTT CONNECT is just as
real a failure as the handshake itself never completing. A plain one-shot
`setTimeout`, not `socket.setTimeout()`/the `timeout` connect option
(which resets on any read/write and would misfire on a healthy, merely-
quiet already-connected session between keepalive pings tens of seconds
apart). Without this, an address that never actively refuses or completes
the connection (firewalled/dropped rather than ECONNREFUSED, or a silent
broker) hung forever — found via a real, reproducible hang in this file's
own test suite (`node --test` on the whole project would hang indefinitely
on the "unreachable broker" test, since connecting to `127.0.0.1:1` never
actually errored in that sandbox the way the test assumed), not a live
report.

**`server/src/notifications/smart-home.js`** is the manager sitting between
`rules.js` and the raw client: owns the one persistent `MqttClient`
singleton, `reconfigureSmartHome()` (idempotent — a settings PUT that
didn't actually change the broker URL/credentials/prefix doesn't reconnect),
`publishSmartHomeEvent({reason, aircraft, matchedEntry})`, and
`testSmartHomeConnection()` for the Settings "Test connection" button. That
last one is more useful than it might sound given QoS 0 has no delivery
acknowledgment: CONNACK is still a real, awaitable handshake independent of
QoS, so "did the broker accept us" is genuinely testable even though "did it
receive our last publish" isn't — the test button opens a **separate**,
temporary connection using whatever's currently in the form (not
necessarily saved yet), so credentials can be verified before committing
them.

**Availability**: standard MQTT pattern — a Last Will (`<prefix>/status` =
`offline`, retained) is set at CONNECT time, delivered by the *broker* if
this client ever disconnects uncleanly (crash, network drop); on success, a
retained `online` is published proactively. Graceful shutdown
(`shutdownSmartHome()`, called from `index.js`'s existing SIGTERM/SIGINT
handler alongside the other flush-on-shutdown calls) publishes `offline`
itself rather than waiting for the broker to notice — same end state either
way, just faster/more deliberate for a routine restart than a crash.

**Payload**: flat JSON (not nested under an `aircraft` key), one topic per
reason (`<prefix>/events/first_seen`, `<prefix>/events/watchlist`,
`<prefix>/events/squawk`) rather
than one shared topic with a `reason` field to filter on — lets a Home
Assistant automation trigger on one specific topic instead of inspecting
the payload. Fields: `reason`, `timestamp`, `hex`, `flight`, `registration`,
`typeCode`, `altitude` (ground = `0`, same convention as the watch list's
own altitude condition), `onGround`, `speed`, `lat`/`lon` (`null` if
unavailable); a watch-list event adds `matchedType`/`matchedValue` so one
HA automation can distinguish which watch-list entry fired. Never
retained — this is a discrete occurrence, not persistent state; a retained
event topic would make every fresh HA subscription immediately re-fire
whatever the last event happened to be.

**Settings**: originally its own "Smart Home" tab (`public/js/settings.js`);
since 2026-08-01 a "Configure smart home" subview *inside* the Notifications
tab (see the Settings-scope section above), with its gating unchanged —
behind `requireSettingsAuth` **like the Server tab**, unlike the rest of the
Notifications tab (ntfy topic, watch list) which stays open — a deliberate
exception, decided explicitly with the user: a broker username/password is
a real infrastructure secret, a different kind of sensitive than a random
ntfy topic string, so it gets the same access-control treatment as the
Settings password itself, the receiver's home location, and the server
port. Stored server-side in SQLite (`smartHomeSettings` config key,
`getSmartHomeSettings`/`updateSmartHomeSettings` in `notifications/
settings.js`) — shared infrastructure config, not a per-browser preference.
A PUT to `/api/notifications/smart-home` calls `reconfigureSmartHome()`
immediately, so toggling the feature or changing the broker takes effect
without a restart, same as every other setting in this app.

**`/dev/smart-home-test`** (added 2026-07-29, requested after the user's
first live Home Assistant test): a form to fire a real event through the
**actual configured connection** without waiting for a genuine first-seen/
watch-list match — lets HA automations be iterated on quickly. Distinct
from Settings' own "Test connection" (which opens a separate, temporary
socket just to check the broker is reachable): this one calls the real
`publishSmartHomeEvent()`, through the real persistent client, so a
success here means the event genuinely went out over the wire. New
`POST /api/notifications/smart-home/send-test-event` (gated the same as
the rest of smart-home) returns `{sent, enabled, connected}` so the page
can distinguish "disabled" from "enabled but broker unreachable" instead
of a silent no-op. **Available in production, like `/dev/icon_verify`** —
same reasoning: a dev machine has no real broker/HA to test against, only
a real deployment does. Two quick-fill presets (a watch-list-style "A380
landing", a first-seen-style "new registration") plus a live JSON payload
preview so the exact topic/body about to be sent is visible before
clicking. Reuses `settings-auth.js` directly (same `sessionStorage` token
Settings' own gated tabs use) rather than inventing a second auth flow.

## Advanced statistics (Stage 7)

The Stats view (`public/js/stats.js`) has six charts plus a lazily-loaded
table of every registration ever seen, each chart re-fetched against a
shared range selector (24h / 7d / 31d / 1y / all, default **all**) rendered
above the charts. The selected range is persisted to `localStorage`
(`mlpr-stats-range`, `loadPersistedRange`/`persistRange` in `stats.js`) —
**directly**, not through `settings-state.js`, because it's remembered UI
state ("what was I last looking at"), not a user-facing Settings option, so
it doesn't belong in that module's schema alongside things that actually
appear as Settings controls. Every chart container shows a `loadingStats`
placeholder the instant a range change (or the initial render) kicks off a
refetch (`drawCharts`'s loop over `[id^="mlpr-chart-"]`/`[id^="mlpr-legend-"]`
elements, before any `await`) — otherwise a slow `all`-range request on a
well-established install reads as a blank box, indistinguishable from
"no data yet". `server/src/stats-query.js`'s `getStatsHistoryForRange`
picks the source and bucket granularity per range: 24h reads the existing
in-memory `history` array (minute-level already) plus today's in-progress
range samples; everything else reads `daily_stats` rows. Bucket granularity
(`server/src/time-buckets.js`): 24h → hourly, 7d/31d → daily, 1y → weekly
(ISO 8601 week numbering — a week belongs to whichever year owns its
Thursday, so e.g. 2025-12-29 buckets into `2026-W01`), all → monthly. This
keeps every chart at roughly 12–60 points regardless of how long the install
has been running, rather than one point per day forever.

### Registrations table (`public/js/stats.js`'s `loadRegistrationsTable`)

`GET /api/stats/registrations` still returns every registration ever seen,
unfiltered — sorting, searching, and paging are all client-side over that
one fetched array, not separate server round-trips. Reasonable at this
project's scale (a home receiver, realistically hundreds to low thousands of
distinct registrations even after a year) and keeps the server-side query
trivial; revisit only if that assumption stops holding. Defaults to sorted
by `timesSeen` descending (most-often-seen first, i.e. "most popular") —
distinct from every other sortable column's own default of ascending on
first click — because "what shows up here a lot" is a more useful landing
view for a spotter than "what showed up most recently." Paginated 20 rows
at a time (`REGISTRATIONS_PAGE_SIZE`); `paginationHtml` renders a
prev/first/current-window/last/next control with an ellipsis wherever a gap
opens up, rather than one button per page, so a few-thousand-row fleet
doesn't turn into a wall of page buttons. The search box
(`#mlpr-reg-search`) matches registration, type, ICAO airline code, and the
*resolved* airline name (not just the code) against a single query, and —
like `list.js`'s aircraft search — lives outside the subtree that
`draw()` rebuilds on every sort/page/search change, specifically so typing
in it doesn't lose focus/cursor position on every keystroke; only
`#mlpr-reg-table-wrap` and `#mlpr-reg-pagination` get rebuilt.

**CSV export** (`public/js/csv.js`'s `rowsToCsv`, both this table and the
all-airlines one, wired through `loadLazyTable`'s shared `exportBtnId`/
`csvFilenamePrefix` params): exports the *current* search-filtered,
sorted view — every matching row, not just the current page — rather
than the whole unfiltered set, kept in sync by every `draw()` in a
closure variable (`currentSorted`) so the export button doesn't redo the
filter/sort work at click time. Each column's `value()` (added alongside
the existing `key`/`label()`) mirrors exactly what `rowHtml()` shows on
screen — the resolved airline *name*, not the raw ICAO code; locale-
formatted dates, not raw timestamps — so the downloaded file matches what
was actually visible, not the underlying JSON shape. `rowsToCsv` itself is
pure/DOM-free (same reasoning as `chart.js`/`geo.js` — testable under
plain `node --test`) and only quotes a field when it actually needs it
(contains a comma/quote/newline), matching how spreadsheet apps write CSV
rather than blanket-quoting every field.

### Range/position sampling (`server/src/stats-history.js`, `range.js`)

`daily_stats` gained `avg_aircraft`, `avg_with_pos`/`max_with_pos`,
`avg_without_pos`/`max_without_pos`, and `range_top_avg_km` alongside the
existing `max_aircraft`/`total_messages`/`max_range_km`. The averages come
from the same daily accumulator pattern already in use (sum + sample count,
divided at flush time).

`range_top_avg_km` is a **deliberate, narrow exception** to "readsb already
computes max range, don't reimplement distance math". `stats.json` only
exposes a single running maximum, never a distribution — there's no way to
show "how good was reception typically" from it alone. So `server/src/
range.js` adds a pure Haversine `distanceKm()`, called once per poll tick
per aircraft-with-position against the effective home location, keeping only
the best distance *per minute* in memory (~1440 floats/day — an ephemeral
rolling aggregate, same category as the existing daily accumulator, not
"raw position history" under hard rule 4). At day rollover this reduces to
two numbers written to `daily_stats`: `max_range_km` (`index.js`'s
`flushDailyStats` takes this from `getRangeSummary()`, i.e. this same
self-computed figure — **not** readsb's `stats.json` `total.max_distance`;
an earlier version of this paragraph said "unchanged, still from readsb",
which was already wrong when written, not a later drift) and
`range_top_avg_km` — the **mean of the top `ceil(n × 10%)`**
per-minute best samples (not a percentile cutoff value — the user asked for
"an average of the best few%," which is a different statistic and was
briefly implemented wrong as a percentile before being caught and renamed).
This makes the number robust against a single lucky MLAT spike inflating an
otherwise-ordinary day. `getRangeSummary()` in `stats-history.js` always
includes the current in-progress minute so a read is never more than ~60s
stale.

**MLAT is now excluded from this sampling entirely** (2026-07-28,
`range.js`'s `isRangeEligible(sourceType)`, true only for a `sourceType`
starting with `adsb_`) — an MLAT position is computed from *several*
receivers' message timing, so a "contact" can be hundreds of km away because
stations elsewhere in the country triangulated it, not because this antenna
actually heard it that far out; the top-10%-average above blunts a single
MLAT *spike* but a receiver in an MLAT-dense area could see its typical
`range_top_avg_km` (and the antenna coverage map/bar chart, `recordAntennaSample`
in `index.js`, gated by the same check in the same loop) skewed by MLAT
contacts routinely, not just as an outlier.

**Update, 2026-08-01: the all-time-max-range notification/tile now also
reads from this same self-computed, MLAT-excluded figure, not readsb's
`stats.json` `total.max_distance`.** Originally left alone deliberately (the
scope note used to read "a single pre-aggregated number with no
per-aircraft breakdown we could filter even if we wanted to; only
`range_top_avg_km` and the antenna stats are in scope") — but that meant
`evaluateRangeRecordRule()` (`notifications/rules.js`) and today's
`getRangeSummary().maxRangeKm` were fed by two independent, differently-
filtered mechanisms (one MLAT-excluded and home-location-aware via our own
`distanceKm()`, one readsb's own unfiltered, receiver-restart-resettable
running counter using whatever origin *readsb* has configured). Reported
live 2026-08-01: Stats showed "Ten dzień" (today) with a *higher* max range
than "Od początku" (all time), which is logically impossible since today is
a subset of all-time. Fixed by calling `evaluateRangeRecordRule(bestRangeKm)`
right alongside `recordRangeSample(bestRangeKm)` in `index.js`'s
`recordRangeAndRegistrationSightings` (removed the old call from
`pollStats`, which fed it `sample.maxRangeKm` off `stats.json`) — both the
daily figure and the all-time record now come from the exact same per-tick
value, so this specific inversion can no longer happen. readsb's own
`total.max_distance` is still ingested into `stats-history.js`'s `history`/
`dailyAccumulator.maxRangeKm` as a side effect of `ingestStats()`, but
nothing reads it back for display or notifications anymore — harmless,
just vestigial; not cleaned up as part of this fix since it wasn't the bug.

### Registration visit-tracking (`server/src/stats-registrations.js`)

Separate from the existing hex-keyed `seen_aircraft` table (first-seen
notifications) — this is registration-keyed and tracks *visits*, not just
"ever seen." In-memory `Map`, same lazy-load-then-periodic-flush shape as
`trail-history.js`: `recordSighting(registration, {typeCode, airlineIcao},
now)` is called from `index.js`'s poll loop for every currently-tracked
aircraft with a registration (not just this tick's delta — every tick,
across the whole tracked set, so a "seen again after 20 minutes" transition
is caught even if the aircraft itself sent no new message in between).
**15-minute visit-gap rule**: if the gap since `lastSeenAt` is `>= 15 min`,
`timesSeen` increments (a new visit); otherwise only `lastSeenAt` advances.
`typeCode`/`airlineIcao` update whenever a later sighting provides them but
are never cleared by a sighting that lacks them. Dirty entries flush to the
`registrations` table (`registration` PK, `type_code`, `airline_icao`,
`first_seen_at`, `last_seen_at`, `times_seen`) on the existing 45s
`DAILY_STATS_FLUSH_INTERVAL_MS` tick — no new interval added.

"Most popular type/airline" and "new registrations" are all derived from
this one table by filtering on `lastSeenAt`/`firstSeenAt` against the
range's cutoff — no separate per-day count tables. "Most popular" counts
**distinct registrations**, not raw sighting frequency, so one aircraft
passing overhead daily doesn't dominate the chart.

### Airline identification (`server/src/airline-lookup.js`)

`identifyOperator(aircraft, airlines)` classifies each aircraft's callsign:
`dbFlags` bit 1 (military) → no airline; callsign (trimmed, uppercased)
equal to the registration with dashes stripped → private/GA, no airline;
else matched against `^([A-Z]{3})([0-9][0-9A-Z]{0,3})$` (3-letter ICAO
prefix, digit immediately after — this also naturally excludes tactical
military-style callsigns like "DUKE21", which have no digit in that
position) and looked up in the loaded airline map. Data source is
OpenFlights' `airlines.dat` — **ODbL-licensed data only, never their AGPL
code** — fetched by `scripts/fetch-airlines.mjs` (hand-written CSV parser,
no new dependency, same pattern as `fetch-mapdata.sh`) into
`data/airlines.json` (`{icao: {name, country}}`, filtered to active airlines
with a non-empty ICAO code), called from `install.sh` alongside the basemap
fetch, best-effort, **never committed** (`data/` already in `.gitignore`).
Served to the browser via `GET /api/airlines`
(`server/src/airlines-data.js` loads it once at startup, empty-Map fallback
if the file doesn't exist yet — e.g. offline install before the fetch
script has run). **Never commit airline logos** — trademark risk, and not
needed since the doughnut charts use plain color swatches + text, not logos.
**Unmatched 3-letter prefixes are logged** (2026-07-28, implemented after
being deferred as a nice-to-have on 2026-07-27): `identifyOperator` calls
`logUnmatchedPrefixOnce(icao, callsign)` whenever a well-formed
airline-shaped callsign's prefix isn't in the loaded `airlines` map
(`kind: 'airline_unknown'`). A module-level `Set` dedupes by prefix so a
frequently-seen unmatched aircraft doesn't spam the log once per poll
tick — only the *first* time a given prefix is seen per process lifetime
gets a `console.warn`, so `journalctl -u mlpr@...` shows what's missing
from OpenFlights' data without drowning in repeats. Plain `console.warn`
rather than threading a pino logger in from `server.js` — this module is a
pure classifier several layers away from the Fastify instance, not worth
the interface churn for a diagnostic like this.

### Chart rendering (`public/js/chart.js`)

Extends the existing hand-rolled `renderSparklineSvg` pattern — no charting
library added (every shape here is a small, well-known SVG technique; a
library buys interactivity nobody asked for at the cost of a new
dependency). All renderers are pure string-building functions, zero DOM
dependency, fully testable under plain `node --test`
(`public/js/chart.test.js`): `renderLineChartSvg` (multi-series + max
label), `renderAreaChartSvg` (stacked, bottom-to-top in series order),
`renderBarChartSvg` (grouped bars), `renderDoughnutSvg`/`doughnutSlices`
(stroke-dasharray technique, slices beyond `maxSlices` folded into one
"Other" entry so a long tail doesn't turn the chart into confetti).
**Single-bucket edge case** (common for "all time" on a fresh install, or
any narrow range with sparse data): a `<polyline>`/`<polygon>` needs ≥2
points to draw anything visible, so with exactly one bucket
`renderLineChartSvg` draws a `<circle>` dot and `renderAreaChartSvg` draws
`<rect>` bar-like columns instead — both caught via a live screenshot during
development (the legend showed real numbers while the chart area itself was
blank), not by the original tests, which only checked for absence of
`NaN`. Regression tests were added for both.

**Hover tooltip** (requested 2026-08-03): every bucketed chart
(line/area/bar — "which bar/line is this and what's its exact value" was
previously answerable only from the Y-axis's max/mid/zero labels and
whatever the legend showed for the *last* bucket). Split the same way as
everything else in this file: `chart.js` stays pure/DOM-free and only
gains **more markup**, not behavior — each bucket gets an invisible
full-height `<rect class="mlpr-chart-hit" data-i="N">` (`pointHitRegionsSvg`
for line/area, inlined for bar), tiled edge-to-edge with no gaps
(Voronoi-style: a bucket's region extends halfway to each neighbour, so
hovering *near* a point, not just exactly on the line, still resolves to
it). Line/area also get a per-bucket vertical guide (`cursorLinesSvg`) and
one `<circle class="mlpr-chart-point" data-i="N">` per bucket per series
(area's sits at the *top* of that series' own stacked slice — the one
point on a filled stack that unambiguously belongs to one series rather
than the combined total under it) — both hidden by default
(`style.css`, `opacity: 0`) and revealed via a `.active` class. Bar charts
skip the guide/points (the bars themselves are already the visual anchor)
and instead get `class="mlpr-chart-bar" data-i="N"` on every bar so a
hover can brighten the whole group at once (`filter: brightness(1.4)` on
`.active`); their hit region is the bucket's whole group column, not just
the bar itself, so hovering the gap between bars in a group still counts.

All the actual DOM/pointer logic lives in `stats.js`'s `wireChartTooltip`,
called once after every `el.innerHTML = renderXChartSvg(...)` (aircraft
count, position, range, new registrations, the top-type/airline trend
line view, and the antenna range-by-altitude bars). It deliberately
**never recomputes which bucket a screen position belongs to** — it only
reads the `data-i` back off whatever element a `pointerdown`/`pointermove`
landed on (`event.target.closest('.mlpr-chart-hit')`), then toggles
`.active` on every element sharing that index and builds the tooltip's
rows from the `buckets`/`series` arrays already in the caller's closure.
Same "the hit-test and the drawing must share one source of truth"
reasoning as the trigger-area editor's rectangle bounds
(`rectangleEdges`/`rectangleRing` computed once, used by both matching and
drawing) — two independently-computed x-to-bucket mappings could silently
disagree; reading back a real DOM attribute the renderer itself wrote
can't. `pointerdown` is wired alongside `pointermove` specifically for
touch, which has no hover state — a tap needs to raise the tooltip
immediately, not only ever update once a drag is already under way.

`series` arrays gained a `label` field (alongside the pre-existing
`key`/`color`) at each call site, purely for the tooltip's row text — the
separately-built legend HTML at those same call sites is untouched and
still writes its own labels by hand, so this is additive, not a
refactor of working code. The tooltip reuses whatever `formatValue`/
`formatBucket` the chart itself was rendered with (imported
`defaultFormatValue`/`formatBucketLabel` as the fallback when a call site
didn't pass its own), so the number/date format in the tooltip can never
disagree with the chart's own Y-axis/X-axis labels.

Positioned from the real `pointermove`/`pointerdown` event's
`clientX`/`clientY` relative to the chart wrapper's own
`getBoundingClientRect()` — not derived from the SVG's internal
`viewBox` coordinate space — so it's correct regardless of how the SVG
happens to be scaled to its container (`preserveAspectRatio="none"`
already means CSS pixels and viewBox units aren't 1:1). Clamped to stay
inside the wrapper (`div[id^="mlpr-chart-"]`/`#mlpr-antenna-chart-bands`,
given `position: relative` in `style.css` via that same attribute
selector so the tooltip's `position: absolute` resolves against the chart
card, not the page) so it can't spill past its own card at either edge —
verified live (Playwright) by hovering the last bucket of a 31-day bar
chart, which sits right at the card's edge.

### Stats v1.1: Now/Today/All-time sections, antenna stats, all-airlines

The Stats view grew three new top sections (each a `.mlpr-stats-section` in
`public/js/stats.js`), ahead of the existing range-selected charts:

- **"Aktualnie" (Now)** replaced the old 3-item `<dl>` tile row entirely
  (there is no separate "kafelki" strip above it any more — a deliberate
  choice, made explicit with the user, to avoid showing aircraft
  count/messages-per-sec twice on one screen). Aircraft count, with-position
  count, messages/sec, and a rolling last-**hour** max range (new — distinct
  from the existing all-time max range tile that used to live here) are live
  numbers already available client-side (`radar-state.js`'s `getLiveStats`/
  `getLiveAircraft`). The **nearest/farthest aircraft tiles** are computed
  **entirely client-side** in `public/js/geo.js`'s `findNearestFarthest` —
  `distanceKm`/`bearingDegrees` are duplicated there from
  `server/src/range.js` (small pure formulas, and this codebase has no
  shared-code mechanism between `server/src` and `public/js`, so duplicating
  ~10 lines was simpler than inventing one). Home location for this is
  **not** read from `app.js`'s existing `homeLocation`/home-marker code —
  `stats.js` does its own independent `fetch('/api/settings')` on panel
  open, same endpoint and therefore same access control as the home marker
  (locked out if a Settings password is set and the browser isn't logged
  in — the tiles then show "no receiver location set" rather than silently
  guessing). Kept deliberately isolated from `app.js` to avoid touching
  already-working, hard-to-verify-under-WebGL map code for an unrelated
  feature.
- **"Ten dzień" (Today)** and **"Od początku" (All time)** both hit one new
  endpoint, `GET /api/stats/summary?period=today|all`, rather than the
  6+ separate requests the range-selected charts below make — these two
  sections aren't range-selector-scoped, so bundling them server-side into
  one payload (`server/src/server.js`) made more sense than reusing the
  per-chart endpoint shape. "Today" reads from newly-added live in-memory
  state; "All time" reads straight from existing persistent tables that
  already tracked exactly this:
  - **Unique aircraft/flights seen today**: genuinely new tracking, because
    neither existing "first ever seen" table (`seen_aircraft`) nor the
    per-registration `registrations` table can answer "was this *also* seen
    today" — an aircraft first seen last month flying again today must
    still count. `stats-history.js`'s `dailyAccumulator` grew two `Set`s
    (`uniqueHexes`, `uniqueFlights`), fed every poll tick from `index.js`'s
    existing per-tick "iterate every tracked aircraft, not just this tick's
    delta" loop (`recordRangeAndRegistrationSightings` — now doing four
    things per aircraft per tick instead of two, still one pass). Reset at
    the same UTC-midnight boundary `dailyAccumulator` already uses (new
    export `getTodayStartMs`) — deliberately reusing that exact boundary
    rather than a second, possibly-inconsistent definition of "today" (e.g.
    local time). Sets aren't JSON-serializable, so `snapshotForPersistence`/
    `restoreFromSnapshot` spread them to/from arrays — same
    restart-survival mechanism as the rest of that file, same reasoning
    (hard rule 6 exempts *today's* accumulated numbers, not just anything
    RAM-only).
  - **All-time unique aircraft/flights/registrations**: no new tracking
    needed for two of these — `seen_aircraft`/`registrations` already
    existed, just needed a `COUNT(*)` (`db.js`'s `getSeenAircraftCount`/
    `getRegistrationsCount`). Unique *flights* all-time needed a new table,
    `seen_flights` (`flight TEXT PRIMARY KEY, first_seen_at`) — same shape
    and same "bounded by distinct callsigns ever seen" reasoning as
    `seen_aircraft`, guarded the same way before every write
    (`hasSeenFlight` SELECT before `markFlightSeen` INSERT, so a per-tick
    loop only ever writes once per callsign ever, not once per tick — hard
    rule 5. Getting this guard wrong here was a real bug caught before it
    shipped, not hypothetical: an early version called `markFlightSeen`
    unconditionally every tick for every aircraft with a callsign).
  - **All-time max range** reuses the notification engine's existing
    `allTimeMaxRangeKm` config value (`server/src/notifications/rules.js`'s
    new `getAllTimeMaxRangeKm` getter) rather than re-deriving it — that
    value was already the correct all-time record, just previously only
    read internally by the range-record notification rule.
- **Doughnut ↔ line toggle** on the two "most common type/airline" charts
  in the existing range-selected section (`chartView` state in `stats.js`,
  two small pill buttons at the chart's top-right, reusing `.mlpr-range-btn`
  styling). The line view is **not** a different chart of the same
  statistic — no per-bucket "how many of this type were active" figure
  exists cheaply — it's *new-registrations-of-this-type/airline over time*,
  reusing the exact same first-seen bucketing as the existing "new
  registrations" chart (`stats-registrations.js`'s new
  `getNewRegistrationsBucketsByKey`), just split into one series per
  already-top-N key from the doughnut's own counts instead of one aggregate
  total. Restricted to the doughnut's own top 5 keys (`TREND_TOP_N`) — a
  long tail of one-off types as separate lines would be pure noise, same
  reasoning `doughnutSlices`' `maxSlices` already applies to the pie view.
  Server endpoint: `GET /api/stats/registrations-trend?range&field=type|
  airline&keys=A,B,C` (comma-separated, from the doughnut's already-fetched
  data — this endpoint never independently decides what's "top", so it
  can't disagree with the doughnut showing the same range).
- **Antenna statistics** (`server/src/antenna-stats.js`, all-time-only —
  deliberately not range-selected or daily-reset, since "which direction
  does my antenna see farthest" is a slowly-accumulated picture that gets
  more meaningful over months, not something that resets or needs a
  24h/7d/etc. view): a **range-by-altitude bar chart** (9 fixed bands, 0–5k
  ft up to 40k+, on-ground aircraft counted as 0 ft — same "ground = 0"
  convention as the watch list's altitude condition) and a **directional
  coverage rose chart** (`public/js/chart.js`'s new `renderRoseChartSvg`,
  180-sector compass rose — see the redesign note below for the resolution
  history — one filled pie-wedge "petal" per sector reaching to a radius proportional to
  that sector's range figure). Persisted as one JSON blob (`antennaStats`
  config key) **only when actually dirty** (`flushAntennaStatsIfDirty` — a
  no-op, no SD write at all, once a receiver's figures stop moving after the
  first weeks). Bearing math (`bearingDegrees`, standard great-circle
  initial-bearing formula) was added to `server/src/range.js` alongside the
  pre-existing `distanceKm`.

  **Redesigned for the map coverage layer below** (originally shipped as a
  single running max per band/sector, like the notification engine's
  pre-existing `allTimeMaxRangeKm`): the user pointed at how Virtual Radar
  Server's and tar1090's own range-coverage visualizations look — jagged,
  spiky "starburst" shapes — and asked whether MLPR could do this better.
  The spikes in both of those come directly from plotting a single running
  maximum (or raw historical traces) per direction: one MLAT glitch or one
  unusually lucky contact creates a permanent, visually dominant spike, and
  neither tool does anything to smooth that out. Per (altitude band,
  sector) cell, `antenna-stats.js` now retains the **best `TOP_K` (5)
  samples ever**, not just the single max (`insertIntoTopK`, a small
  sorted-and-capped array, still O(1)-ish and bounded regardless of how
  long the receiver runs — hard rule 4 is still satisfied, this is nowhere
  close to raw position history). Two figures come out of each cell for
  free: `maxRangeKm` (the single best-ever contact — the same honest
  "record" figure as before) and `topAvgRangeKm` (the mean of the retained
  best 5 — outlier-resistant, since one MLAT glitch is diluted against 4
  realistic samples instead of standing alone). The **Stats rose chart and
  bar chart now show `topAvgRangeKm`** (bar chart shows both, as two series,
  same two-color pattern as the pre-existing "Antenna range" history chart)
  — smoother and more representative than before, a quality improvement
  independent of the map feature.

  **Sector count**: 16 → 72 → 120 → **180** (2° each), the third bump made
  2026-08-02 on request, after this exact tradeoff was walked through in
  conversation rather than just picked: too coarse and a single sector
  "speaks for" a wide swath of real geography at long range (arc length at
  radius r is r·θ, so a 22.5° sector covers ~10x the ground at 300 km that
  it does at 30 km) — literally flattening a wedge of real, possibly-varying
  coverage into one number too coarsely; too fine and most sectors would
  rarely accumulate enough real contacts for a `top-5` figure to mean
  anything for a typical home receiver's traffic density. Storage/CPU/
  network cost is **not** the limiting factor at any resolution discussed
  (72, 90, 120, 180, 360 were all compared) — each recorded sample only ever
  touches one sector regardless of `SECTOR_COUNT`, `BAND_SLOTS × SECTOR_COUNT
  × TOP_K` only grows from 6,000 to 9,000 floats going 120→180, and the
  coverage endpoint's two GeoJSON rings only grow from ~242 to ~362 points —
  a few KB either way, trivial against hard rule 8's 150 MB backend budget
  and a non-issue for the browser rendering it. 360 was considered and
  explicitly **not** taken this round — same statistical-sparsity reasoning
  as below, just more of it, and 180 was picked as the next incremental step
  to observe live rather than jumping straight to the finest option
  discussed; nothing rules out 360 later once 180's real-world sparsity is
  seen firsthand. 180 (2°, ~10–14 km of arc at a strong receiver's
  realistic max range, down from ~15–21 km at 120) is where this lands. The
  sparsity concern above is real but self-corrects as more data accumulates
  over weeks/months, and hits per-band views harder than the "all
  altitudes" one (which merges across all 10 band slots per sector, so it
  stays well-populated much sooner).
  An extra, internal-only "unknown altitude" band slot (`UNKNOWN_BAND_SLOT`)
  preserves a sample's directional information even when it has no altitude
  data at
  all (Mode-S-only contacts) — it's included when merging for the "all
  altitudes" view (`getSectorStats(null)`) but never shown as its own named
  band, matching what the pre-redesign single sector-only tracking already
  covered.

  A stored config blob from before this redesign (a different shape) is
  detected and ignored by `ensureLoaded`'s shape check, starting fresh
  rather than crashing — same defensive pattern already used elsewhere for
  persisted config (e.g. `restoreFromSnapshot`'s date guard in
  `stats-history.js`).

  **Signal strength** (current mean/peak, in dBFS) is a separate, much
  simpler live-only reading — `stats.last1min.local.signal`/`peak_signal`
  from readsb's own `stats.json` (verified against readsb's own
  `README-json.md` before adding — see the "aircraft.json contract" rule
  above about not inventing fields), ingested every ~15s alongside the
  existing `pollStats`, **not averaged or persisted** (just the latest
  reading, same spirit as the existing messages/sec live number). Absent
  entirely (not zero — `null`) for a `--net-only` readsb with no local SDR,
  shown as a plain "not available" message rather than a misleading `0
  dBFS` tile.
- **All airlines table**, mirroring the existing "all registrations" table
  (lazy-loaded on click, client-side sort/search/paginate over one fetched
  array). No new table needed — `db.js`'s `getAllAirlinesSummary` is a
  `GROUP BY airline_icao` aggregate straight off the existing
  `registrations` table (registrations with no resolved airline excluded,
  same as the doughnut chart). The two now-near-identical lazy-table
  implementations (registrations, airlines) were factored into one shared
  `loadLazyTable` helper in `stats.js` — worth it once there were genuinely
  two call sites of a ~150-line pattern, not before.

### Reception coverage map layer (Settings → Map, off by default)

A real shape drawn on the map itself (not just the Stats panel's rose
chart), showing how far the receiver has picked up aircraft in each
direction — the antenna-stats.js redesign documented above exists
specifically to feed this well. Two polygons over one shared GeoJSON
source/two layers (`public/js/app.js`'s `ensureCoverageLayer`, same
"one source, two layers filtered by a property" shape as the pre-existing
trail/trail-gap split, forced by the same constraint: `fill-opacity`/
`line-dasharray` aren't per-feature-expressible within one layer):

- **Fill** (`mlpr-coverage-fill`): the outlier-resistant `topAvgRangeKm`
  boundary, semi-transparent filled polygon — the primary, "typical
  excellent reception" shape.
- **Outline** (`mlpr-coverage-outline`): the honest single-best-ever
  `maxRangeKm` boundary, thin dashed line only, no fill — deliberately kept
  as a second, visually distinct layer rather than dropped, so the record
  contact is still visible without it dominating the whole shape (which is
  exactly VRS's/tar1090's problem).

**Server** (`GET /api/stats/antenna/coverage?band=all|0..8`,
`server/src/server.js`): calls `getSectorStats(bandIndex)` at full 72-point
resolution, then a new `destinationPoint(lat, lon, bearingDeg, distanceKm)`
in `range.js` (the direct-geodesic problem, inverse of the pre-existing
`distanceKm`/`bearingDegrees` pair — verified round-trip against them in
`range.test.js`) turns each (bearing, range) pair into a real lat/lon,
building two closed GeoJSON-ready rings. **Gated by `requireSettingsAuth`,
same as `/api/settings`** — every vertex is `home ± bearing ± distance`, so
the polygon is exactly as revealing of the receiver's exact location as the
home marker already is; this is not a special case that bypasses that
access control. A sector with nothing recorded yet resolves to distance 0,
i.e. `destinationPoint` just returns the home coordinate — the polygon
"pinches" to the center in that direction, which is the correct, honest
representation of "no data here yet" (not a special case to guard against).

**Client**: `showCoverage` (default **off** — a heavier, niche feature, not
something every install wants cluttering the map by default) and
`coverageBand` (`'all'` or an `ALTITUDE_BANDS` index 0–8) in
`settings-state.js`, a new "Coverage" fieldset in Settings → Map
(`settings.js`) with a checkbox + altitude-band `<select>`, both
per-browser like every other Map-tab setting. Color comes from
`trail.js`'s existing `colorForAltitude`, fed a representative midpoint
altitude per band (`COVERAGE_BAND_MIDPOINT_FT` in `app.js`) — reuses the
same gradient trails already use rather than inventing a second palette;
"all altitudes" gets a fixed neutral green instead, since there's no single
altitude to place on that gradient. Re-fetched when `showCoverage`/
`coverageBand` actually change (`lastRequestedShowCoverage`/
`lastRequestedCoverageBand`, same "track what was last applied" pattern as
`lastRequestedBasemapMode`/`lastRequestedMapTheme`), **and** on a
`COVERAGE_REFRESH_INTERVAL_MS` (15s) timer while it's on — the first
shipped version only had the former, which meant a tab left open with
coverage enabled would show an increasingly stale shape as new farther
contacts got recorded server-side, only catching up on a manual reload or
toggling the setting off and back on (reported live, 2026-07-28; this
class of bug is exactly why it's polled rather than pushed over the
existing WebSocket in the first place — nothing was driving a refresh at
all). The last-fetched GeoJSON is cached and reapplied by
`ensureCoverageLayer` whenever the style resets (`setStyle` on a basemap
switch wipes all sources, same reason the trail layer already has to
re-add itself on `style.load`).

**A note on verifying anything in this section**: this sandbox has no
WebGL (`GL_VENDOR = Disabled`, confirmed multiple ways earlier in
development), and `new maplibregl.Map(...)` throws *synchronously* inside
its constructor when that happens — which halts the rest of `app.js`'s
top-level module evaluation, including every `onSettingsChange`/`setInterval`
registration below it. A real browser's console only reports the one
WebGL error and otherwise looks quiet, which reads exactly like "no
errors, must be fine" — but nothing past that point in the module ever
ran. This is *not* hypothetical: it's exactly how the missing-periodic-
refresh bug above shipped in the first place, verified only by checking
for new console errors after toggling the setting, never by checking that
the fetch actually happened. Re-verifying this section (or anything else
in `app.js` reacting to settings/timers) needs the FakeMap/FakeMarker/
FakePopup stub technique (route-intercept `/vendor/maplibre-gl/
maplibre-gl.js` and serve a fake implementing just the methods `app.js`
calls) so the module actually finishes loading — a screenshot or a
"no new console errors" check alone will not catch a dead reactive path.

## Settings access control (`server/src/settings-auth.js`)

Off by default (local LAN app, most people don't need this) — a button in
Settings → Server ("secure this section with a password") opts in.
`node:crypto`'s `scryptSync` for password hashing (random salt per password,
no new dependency), `timingSafeEqual` for comparison. Sessions are random
tokens issued on login, held **in memory only** (`Map<token, expiresAt>`,
24h TTL, pruned hourly) — lost on restart, which just means logging in again,
consistent with hard rule 6.

**Brute-force lockout** (`isLockedOut`/`recordFailedAttempt`/
`recordSuccessfulAttempt`, same in-memory-only spirit as the tokens above,
pruned on the same hourly tick): per-IP, 5 failed `verifyPassword()` calls
within the lockout window lock that IP out for 5 minutes (`429`, checked
*before* the password check runs, so a locked-out client can't spend a
guess waiting it out). Guards **both** call sites that verify the password
— `/api/settings-auth/login` and `/api/settings-auth/password`'s own
`currentPassword` check — since unlimited attempts against either made the
password guessable. No exponential backoff or persistence: a fixed
threshold/window is enough for a home LAN app and needs no bookkeeping
beyond a plain `Map`.

**Gates the Server tab only, not the whole Settings panel** — this was a
deliberate narrowing (originally the password gated the entire panel before
opening it at all). Everything on the other four tabs is either per-browser
`localStorage` or shared state with no real reason to hide it from anyone
who already has LAN access to the app (notification rules, the watch list);
the only things worth an access-control boundary are server-level controls:
the password itself, the receiver's home location, and the listening port.
Protected via a `requireSettingsAuth` Fastify `preHandler` applied per-route
to `/api/settings*` (home location) and `/api/server/port*` — **not**
applied to `/api/notifications/*` (moved out when the gate was narrowed),
`/api/settings-auth/*` itself (login/status/password-management need to
work *without* being logged in yet), `/api/daylight`, or `/api/stats/history`
(general app data, not a setting). The preHandler is a no-op whenever no
password is set, so the default-open behavior is unchanged until someone
opts in.

Frontend-side, this means `public/js/settings.js`'s `renderSettingsForm`
always renders all five tabs immediately — there is no longer a top-level
gate blocking the panel from opening. Only the Server tab's own root element
(`renderServerTab`) checks `passwordSet && !getStoredToken()` and swaps in
the login form (`renderGate`, reused from before) instead of the real
fieldsets when locked; `authedFetch` takes an explicit `onUnauthorized`
callback per call site now (previously it always re-rendered the whole
panel) so a 401 only resets the Server tab's own content, not General/Map/
Aircraft/Notifications underneath it. The token itself still lives in
`sessionStorage` (`public/js/settings-auth.js`) and is attached via the
`X-MLPR-Settings-Token` header.

Setting/changing/removing the password itself is **not** behind the token
preHandler — changing it requires the *current* password (checked inside the
handler), which works independently of whether a session token happens to be
valid. First-time setup (no password yet) needs neither.

## Production deployment (Stage 6)

`scripts/install.sh` + `systemd/mlpr@.service` — a templated unit (`User=%i`,
`WorkingDirectory=/home/%i/My-Local-Plane-Radar`), instantiated as
`mlpr@<username>.service`. The install script detects too-old/missing Node
and **aborts with NodeSource instructions rather than auto-installing** (that
needs the user's own sudo password, which nothing here can supply), runs
`npm ci --omit=dev` (skips the Playwright devDependency — it's ~300+MB and
dev-only, never needed on the Pi), fetches the basemap if missing, then
installs/enables the unit (needs sudo — expected, this is a script the user
runs themselves, not a web endpoint).

It also wires up readsb's `--db-file` if readsb is present (`/etc/default/readsb`
exists) and doesn't already have it configured: downloads
[wiedehopf/tar1090-db](https://github.com/wiedehopf/tar1090-db)'s
`aircraft.csv.gz` to `/usr/local/share/tar1090/`, appends `--db-file` to
`JSON_OPTIONS` (or adds the line if missing), and restarts readsb. Without
this, `r`/`t`/`desc` (registration/type/description) are never present in
`aircraft.json` **for any aircraft, ever** — not a per-aircraft data gap, a
missing local lookup file — which silently breaks both the aircraft details
panel's registration/type tiles and the `military`/`interesting`/`pia`/`ladd`
dbFlags bits everywhere. Idempotent (checked by grepping for `--db-file`
first) and best-effort (a failed download warns and continues rather than
failing the whole install — same philosophy as the basemap fetch step).
This is configuring readsb via its own documented `EnvironmentFile`
mechanism, not modifying readsb itself — doesn't cross the GPL boundary
described earlier.

`index.js` handles `SIGTERM`/`SIGINT` (what `systemctl stop`/`restart`, and a
normal `sudo reboot`'s shutdown sequence, all send): flushes the in-memory
daily-stats accumulator to SQLite before exiting, so a routine restart
doesn't lose up to 45s of that day's aggregate. This is the one piece of
"current state" worth saving on shutdown — live aircraft state staying
RAM-only and getting dropped on restart (hard rule 6) is still fine and
unchanged.

**`closeWebSockets()` must be called before `await app.close()`** (added
2026-08-01, `server.js` returns it alongside `app`/`broadcast`). An upgraded
WebSocket is still one of the HTTP server's own connections and never ends
on its own, so `app.close()` — which waits for every connection to drain —
waited *forever* whenever any browser tab was open. In practice
`systemctl restart` hung until systemd's `TimeoutStopSec` (90s by default)
gave up and SIGKILLed, on every restart and every reboot with a tab open.
Data was never at risk (all the flushes above already run before
`app.close()`); it was purely a 90-second stall, which is exactly why it
went unnoticed for so long — everything still worked, just slowly.
Reproduced deterministically before and after: **no WS client → exits in
~200ms; one WS client → never exits**; after the fix ~500ms with 0, 1 or 5
clients. Uses `ws.terminate()`, not `ws.close()`: `close()` starts a
closing handshake and waits for the peer to answer, which an unresponsive
client may never do — the same hang in a smaller form. The process is
exiting anyway and `app.js`'s own WebSocket `close` handler reconnects a
second later, so dropping the socket outright is both safe and what a
restart wants. If a future change adds another kind of long-lived
connection, it needs the same treatment — the symptom to watch for is a
log line saying "shutting down" with the process still alive afterwards.

### Stats history snapshot (`snapshotForPersistence`/`restoreFromSnapshot`
in `stats-history.js`)

The 24h charts (aircraft seen, with/without position, antenna range) read
from `stats-history.js`'s in-memory `history` array and range-sampling
state, which — unlike the small `daily_stats` row above — were **not**
persisted at all until this was added, so every restart reset them to
empty; a user would see today's 24h charts blank out and slowly rebuild
over the following hours. Worse, a *same-day* restart also silently
regressed `daily_stats`: the in-memory `dailyAccumulator` reset to zero on
startup, and the next periodic flush would upsert today's row with only
the since-restart numbers, discarding whatever had accumulated before the
restart even though it had already been written once. Both were reported
live as "all my statistics disappear on reboot" (2026-07-27) — diagnosed by
actually testing the existing SIGTERM-flush-then-restart path first (it
does work, proving the *daily_stats* row mechanism itself was sound) before
looking for what it didn't cover.

Fix: `snapshotForPersistence()` captures everything needed to resume
exactly where today left off (`history`, the full `dailyAccumulator`,
`todaysRangeSamples`, and the in-progress-minute range state);
`restoreFromSnapshot()` restores it **only if the snapshot's date is
today** (a snapshot from yesterday, e.g. the Pi was off overnight, must
never be restored — `rolloverIfNewDay` already handles a day boundary
crossed while running, this is the equivalent guard for the one-time
startup restore). `index.js` persists this via `setConfigJSON`/
`getConfigJSON` (the `config` table, same JSON-blob pattern as the watch
list) on its own **hourly** interval (`STATS_HISTORY_SNAPSHOT_INTERVAL_MS`)
— deliberately much less frequent than the 45s `daily_stats` flush, since
this blob (up to 1440 samples) is far bigger and repeated full-blob
rewrites matter for SD wear (hard rule: batch writes, minimize SD wear).
Also written on the same graceful-shutdown path as the `daily_stats` flush,
so a routine restart loses at most the current in-progress interval, not
the whole day. Restored once at startup, before the poll loops start, so
the first client to connect after a restart already sees the real numbers.

## Documentation (`docs/`)

`docs/README.md` is the user-facing guide (GitHub renders it automatically
when browsing the `docs/` folder) — a screen-by-screen tour of the map, List,
Stats, and every Settings tab, linked from the main `README.md`'s new
"Features" section. `docs/images/` holds real screenshots (Settings' five
tabs, List, Stats + its registrations table/pagination, and a hand-built
aircraft-icon-shape gallery) taken against synthetic seeded data — **never
real receiver data or coordinates**, consistent with the home-location rule
above. This is separate from `CLAUDE.md` (architecture/decisions, for
future development sessions) and `TODO.md` (deferred work) — `docs/` is
purely for end users setting up and using the app, written to grow
alongside the feature set rather than as a one-time snapshot.

## How we work

- Small, vertical slices — always something working end-to-end, never "all
  backend, then all frontend."
- Commit often, in small pieces, with meaningful messages. Git is the undo
  mechanism.
- Tests for the rule engine and JSON parsing are mandatory (`fixtures/` +
  built-in `node:test`). Everything else is optional.
- Code and comments in English (project is public). Conversation happens in
  Polish.
- Raspberry Pi-specific things (systemd units, `/run/readsb` permissions, ARM
  dependencies) get verified by the user on real hardware. If something isn't
  certain, say so instead of guessing.
- When in doubt about a requirement — ask, don't assume.
- Whenever the user says something is deferred ("we'll do that later",
  "improve it later"), add it to `TODO.md` immediately rather than letting it
  evaporate.
