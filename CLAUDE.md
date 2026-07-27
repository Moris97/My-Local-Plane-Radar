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
    "MapLibre" credit (`maplibre.org`) always shown in both modes, and a
    "© OpenStreetMap contributors" link (`#mlpr-osm-attribution`, toggled by
    `updateAttributionVisibility()` in `app.js`) shown only while
    `basemapMode` is effectively online. Note MapLibre GL JS itself
    (BSD-3-Clause) does **not** legally require an on-map credit — only
    keeping the license text in the repo/docs (already covered by
    `THIRD_PARTY.md`/`LICENSE`) — the MapLibre credit is included anyway per
    explicit request, not a license obligation. Offline mode (Natural Earth,
    public domain) needs no data attribution, hence only the MapLibre half
    shows.
  - **Position**: pinned to the true bottom-right corner (`bottom: 6px`) only
    on screens `>=720px` wide (`public/css/style.css`, reusing the
    breakpoint the bottom-sheet/side-panel split already uses) — below that
    it stays raised above the bottom bar's height
    (`calc(var(--bottom-bar-height) + 4px)`), the old default for every
    width. Below ~420px wide, a full-length credit pinned to the literal
    corner collides with the Settings pill button, since the bottom bar's
    buttons are centered and leave little room beside a right-anchored
    corner element (measured empirically, not guessed — see the git history
    for this line). This was **not** an issue before the bottom bar was
    redesigned as floating pills (see below): the old opaque full-width bar
    was the reason for the raised position everywhere, and simply hadn't
    been revisited when that redesign made the bar transparent, which is
    what the raised position on wide screens looked like a bug (floating in
    empty space above the actual corner) rather than a deliberate choice.
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
  altitude range where it belongs.
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
  half the icon.
- **Icon size is user-adjustable** (`aircraftIconSize` in `settings-state.js`,
  default 40px, a Settings → Aircraft slider, range 24–64px) — applied via a
  single CSS custom property (`--mlpr-plane-size`, set on `documentElement`
  by `app.js`'s `applyIconSize`) rather than touching every marker element
  individually, so every currently-rendered marker resizes live as the
  slider moves. The popup offset above is derived from this setting, not
  hardcoded, so it keeps clearing the marker at any size.
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
- **Map label under each aircraft** (`public/js/aircraft-icon.js`'s
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
    *before* it in `aircraft-icon.js`'s markup so it paints behind —
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
| General | units | `localStorage` |
| Map | basemap mode, map theme, trails | `localStorage` |
| Aircraft | marker color mode, icon size, altitude filter | `localStorage` |
| Notifications | notification rules, ntfy topic, watch list | SQLite (shared) |
| Server | Settings password, server port, *receiver location* | SQLite (shared) |

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
from. Saving asks for confirmation first (`window.confirm`, this codebase's
only use of it — a deliberately heavier gate than the inline status
messages everywhere else, since mistyping a port on a headless Pi is an
easy way to lock yourself out): the message states the *exact* new address
(`location.protocol`/`location.hostname` — the host the browser is already
on, unchanged — plus the new port), not a vague "somewhere else" warning.

## Notification engine

Implemented (Stage 5) in `server/src/notifications/`: `rules.js` (evaluation),
`cooldown.js` (per-`${ruleType}:${hex}` in-memory cooldown, default 30 min),
`ntfy.js` (delivery), `settings.js` (enabled/disabled rules + the ntfy topic,
persisted in the SQLite `config` table — see `db.js`'s JSON config helpers).

Live triggers: squawk 7500/7600/7700, first-time-seen aircraft (checked
against the `seen_aircraft` table — grows for the life of the install, bounded
by distinct aircraft ever seen, not a "position history" table so it's fine
under hard rule 4), new all-time range record (compared against a
`allTimeMaxRangeKm` config value, fed by `stats.json`'s own `max_distance` —
no per-aircraft distance math needed), and a **watch list**
(`watchlist.js`): entries `{id, matchType: type|registration|flight,
matchValue, altitudeOperator: below|above|null, altitudeValue}`, stored as
JSON in `config` (same pattern as notification settings). Matching is
case-insensitive on `aircraft[typeCode|registration|flight]`; the altitude
condition treats `onGround` as altitude 0, and simply doesn't match if the
needed altitude data isn't available (never a false positive from missing
data). Each rule respects its own enabled/disabled toggle from Settings;
**squawk and watch-list both have a per-hex cooldown** (first-seen and
range-record are naturally one-shot per hex/record already).

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
secure context, awkward over plain HTTP on a LAN) — ntfy is the only delivery
channel for now.

**Known rough edge**: on a fresh install (empty `seen_aircraft` table), every
aircraft currently in range will fire a "first seen" notification. Not fixed
— mention it if the user is surprised by a notification burst right after
first setup.

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

### Range/position sampling (`server/src/stats-history.js`, `range.js`)

`daily_stats` gained `avg_aircraft`, `avg_with_pos`/`max_with_pos`,
`avg_without_pos`/`max_without_pos`, and `range_top_avg_km` alongside the
existing `max_aircraft`/`total_messages`/`max_range_km`. The averages come
from the same daily accumulator pattern already in use (sum + sample count,
divided at flush time).

`range_top_avg_km` is a **deliberate, narrow exception** to "readsb already
computes max range, don't reimplement distance math" (that note is about the
*existing* all-time-max-range notification feature, which is untouched and
still reads `stats.json`'s `total.max_distance` directly). `stats.json` only
exposes a single running maximum, never a distribution — there's no way to
show "how good was reception typically" from it alone. So `server/src/
range.js` adds a pure Haversine `distanceKm()`, called once per poll tick
per aircraft-with-position against the effective home location, keeping only
the best distance *per minute* in memory (~1440 floats/day — an ephemeral
rolling aggregate, same category as the existing daily accumulator, not
"raw position history" under hard rule 4). At day rollover this reduces to
two numbers written to `daily_stats`: `max_range_km` (unchanged, still from
readsb) and `range_top_avg_km` — the **mean of the top `ceil(n × 10%)`**
per-minute best samples (not a percentile cutoff value — the user asked for
"an average of the best few%," which is a different statistic and was
briefly implemented wrong as a percentile before being caught and renamed).
This makes the number robust against a single lucky MLAT spike inflating an
otherwise-ordinary day. `getRangeSummary()` in `stats-history.js` always
includes the current in-progress minute so a read is never more than ~60s
stale.

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
Logging unmatched 3-letter prefixes for future review was discussed as a
nice-to-have but not implemented — see `TODO.md`.

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

## Settings access control (`server/src/settings-auth.js`)

Off by default (local LAN app, most people don't need this) — a button in
Settings → Server ("secure this section with a password") opts in.
`node:crypto`'s `scryptSync` for password hashing (random salt per password,
no new dependency), `timingSafeEqual` for comparison. Sessions are random
tokens issued on login, held **in memory only** (`Map<token, expiresAt>`,
24h TTL, pruned hourly) — lost on restart, which just means logging in again,
consistent with hard rule 6.

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
