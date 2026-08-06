# CLAUDE.md — My Local Plane Radar (MLPR)

This file is persistent memory for future sessions working on this repo.
Read it before making architectural decisions.

**Detailed investigation history** for many decisions below (exact dates,
"reported live" quotes, step-by-step debugging journeys, comparison
walkthroughs) has been moved to `CLAUDE.local.md` — a gitignored, local-only
file (not pushed to GitHub, this file stays public). The rule/decision and
its short "why" always stay here; check `CLAUDE.local.md` if the one-line
reason here isn't enough context to avoid repeating a mistake.

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
  version. Do not add that flag anywhere (code or systemd unit). Confirmed on
  Node 24.18: no `ExperimentalWarning` at all. If an older/different patch
  version prints one, that's expected — don't globally suppress warnings with
  `--no-warnings`.
- `data/mlpr.db` path is overridable via `MLPR_DB_PATH` (tests use an
  isolated temp database instead of the real one).
- The Pi's systemd unit must invoke Node from **`/usr/bin/node`** (NodeSource
  package), not a version manager (no nvm/fnm on the Pi).
- **Debian Trixie's `apt` only has Node 20.19**, too old. Install
  script/README must install from NodeSource, never `apt install nodejs`,
  and should detect a too-old system Node and abort with a clear message.
- If `node:sqlite` ever proves insufficient, **ask before** adding a native
  dependency (e.g. `better-sqlite3`) — native modules built on x86 don't run
  on ARM.

## Architecture

```
SDR + readsb
     |  writes once per second, atomic rename (no partial reads, no locking needed)
/run/readsb/aircraft.json   (tmpfs — reads are free)
     |  polled by backend
Backend (Node.js + Fastify + ws)
   |- current state in memory (hex -> aircraft)
   |- rule engine -> notifications
   |- SQLite (node:sqlite): events + daily aggregates only
     |  WebSocket (deltas)          |  HTTP POST
Browser (map, MapLibre GL JS)    ntfy / Telegram
```

### Data source abstraction

One interface, three implementations, selected by environment variable:

| Implementation | Purpose |
|---|---|
| `FileSource` | reads `/run/readsb/aircraft.json` — production on the Pi |
| `HttpSource` | fetches the same JSON over HTTP from the Pi — dev on WSL against live data |
| `ReplaySource` | replays recorded snapshots from `fixtures/` — tests and demo mode |

`scripts/record-fixtures.sh` records ~10 minutes of snapshots into `fixtures/`.

**`HttpSource` fetch calls carry a timeout** (`AbortSignal.timeout`,
constructor option `timeoutMs`, default 3s) — `pollOnce()` runs on a plain
`setInterval` (`index.js`) that does **not** wait for the previous call to
finish, so a stalled connection without a timeout piles up a new hung
request every second forever, rather than just delaying a tick.

### `aircraft.json` contract

One JSON object: `{ now, messages, aircraft: [...] }`. readsb writes to a temp
file and atomically renames it — never a half-written file, no locking
needed. `server/src/normalize.js` is the single place that reads raw readsb
field names; everywhere else uses the camelCase names on the right. **Treat
every field as optional**, many are frequently absent.

- `hex` — 24-bit ICAO address, primary key
- `flight` → `flight` — callsign, trailing spaces, must be trimmed
- `lat`, `lon`, `seen_pos` → `seenPos`
- `alt_baro` → `altBaro` — **can be the string `"ground"`** instead of a
  number (becomes `onGround: true`, `altBaro` cleared)
- `alt_geom` → `altGeom`, `gs`, `track`, `baro_rate` → `baroRate`
- `ias`, `tas`, `mach`
- `track_rate` → `trackRate`, `roll`, `mag_heading` → `magHeading`,
  `true_heading` → `trueHeading`, `geom_rate` → `geomRate`
- `squawk` — string, not a number
- `emergency` — string enum; `"none"` normalized away to `undefined`
- `category`, `version`, `type` → `sourceType` (not `typeCode`, this is the
  ADS-B/MLAT/Mode-S source-quality enum, e.g. `adsb_icao`), `r` →
  `registration`, `t` → `typeCode`, `desc`
- `dbFlags` — bitmask; bit 1 = `military`, bit 2 = `interesting`, bit 4 =
  `pia` (Privacy ICAO Address), bit 8 = `ladd` (Limiting Aircraft Data
  Displayed)
- `nav_qnh` → `navQnh`, `nav_altitude_mcp` → `navAltitudeMcp`,
  `nav_altitude_fms` → `navAltitudeFms`, `nav_heading` → `navHeading`,
  `nav_modes` → `navModes` (array of strings) — deliberately **not** in
  `state.js`'s `CHANGE_FIELDS` (arrays can't go there: `normalizeAircraft`
  allocates a new array every poll, so reference equality would always read
  "changed")
- `nic`, `rc`, `nic_baro` → `nicBaro`, `nac_p` → `nacP`, `nac_v` → `nacV`,
  `sil`, `sil_type` → `silType`, `gva`, `sda`
- `alert`, `spi` — 0/1 in raw JSON, converted to booleans
- `rssi`, `messages`, `seen`
- `wd`, `ws`, `oat`, `tat` — readsb-computed wind/temperature, passed through

Deliberately **not** read: `lastPosition`/`rr_lat`/`rr_lon` (position
fallback plumbing), `acas_ra`/`gpsOkBefore` (readsb docs mark experimental).

Do not invent fields not listed here — verify against docs or a live file,
or ask.

`server/src/state.js`'s `CHANGE_FIELDS` decides which fields force an
immediate resend vs. riding along passively. Rule of thumb: primary
flight-dynamics fields (position, altitude, speed, heading, squawk, nav
targets, alert/spi/emergency) are tracked; receiver/signal-quality metrics
and computed secondary stats (rssi, messages, seen, nic/rc/nac/sil/gva/sda,
wd/ws/oat/tat) are volatile.

### `receiver.json` and `stats.json` (siblings of `aircraft.json`)

Each `Source` exposes `fetchReceiverInfo()` and `fetchStats()`, resolved as
sibling paths/URLs next to the configured `aircraft.json` location.
`ReplaySource` returns `null` for both.

- `receiver.json` rarely changes — read **once at startup**. Fields used:
  `lat`, `lon` (receiver position), `version`, `refresh`.
- `stats.json` is rewritten continuously — poll every ~15s, only act when
  `last1min.end` advances (`stats-history.js`). Fields used:
  `last1min.messages` and `last1min.local.signal`/`peak_signal`. **Its
  aircraft counters (`aircraft_with_pos`/`aircraft_without_pos`) and
  `total.max_distance` are deliberately NOT read** — readsb keeps its own
  accounting with its own timeouts and its own unfiltered distance record,
  so those answer the same questions as MLPR's own state but differently,
  and putting both on one screen produced visible disagreements (see
  "Aircraft counts" below and the range-sampling section). What is left is
  the genuinely receiver-level metric we cannot compute ourselves.
  **`last1min` is a *sliding* 60-second window whose `end` is simply "now"
  at write time, not a fixed one-minute bucket that ticks over once a
  minute** — every 15s poll sees a fresh `end`, so the "only act when it
  advances" guard filters nothing and a naive reader gets four overlapping
  samples per minute. Both consequences were live bugs (see "Advanced
  statistics"): a sample-count-capped 24h buffer held ~6h, and summing
  `last1min.messages` per poll counted most messages ~4x. Anything reading
  `last1min` must dedupe by minute itself.

### Home-location resolution (`server/src/home.js`)

Effective home = manual override (SQLite `config` table) if set, else
`lat`/`lon` auto-detected from `receiver.json` at startup, else `null`.
Exposed via `GET`/`PUT /api/settings`. **Never hardcode real receiver
coordinates anywhere in code, tests, commits, or this file** — use
placeholder values (e.g. `50.0, 20.0`) in examples/tests.

**Home marker** (`app.js`'s `homeMarker`/`refreshHomeLocation`, toggle
`showHomeMarker` in `settings-state.js`, Settings → Map): pulsing dot at the
receiver's location, rendered only when configured. Deliberate exception to
`/api/daylight`'s "never hand exact coordinates to the browser" rule — a
home marker drawn on the map inherently needs the real lat/lon client-side.
Reuses `GET /api/settings` (same endpoint the Server tab uses), so it's
subject to the same access control: if a Settings password is set, an
unauthenticated browser just doesn't see it.

**Initial map center**: on load, `refreshHomeLocation()` runs before the
queued-message flush; if a home location is configured/detected,
`map.jumpTo({ center: [homeLocation.lon, homeLocation.lat], zoom:
INITIAL_ZOOM })` (9) runs immediately, replacing the old "jump to wherever
the first aircraft in the snapshot happens to be" behavior. Falls through to
that old fallback unchanged when no home is available. `hasCentered` still
resets on every full snapshot/WS reconnect — a mid-session reconnect still
falls back to "first aircraft," deliberately out of scope for this fix.

## License policy

- Project license: **MIT** (`LICENSE` at repo root).
- Allowed dependency licenses: **MIT, ISC, BSD-2-Clause, BSD-3-Clause,
  Apache-2.0, CC0, public domain.**
- **AGPL is forbidden, no exceptions** — would force a license change for
  network-served apps like this one.
- GPL/LGPL dependencies: **ask the user first**, every time.
- **Never add a new dependency without asking.** State: name, license, size,
  and why it can't reasonably be hand-written in a few dozen lines.
- Keep `THIRD_PARTY.md` current whenever a dependency is added or removed.
- Never let private data (home location/coordinates, personal API tokens,
  etc.) land in files committed to the public repo.

### Repo hygiene

- `.gitattributes`: `* text=auto eol=lf` (CRLF from Windows would break
  shell scripts on the Pi).
- `.gitignore`: `node_modules/`, `*.db`, `*.db-wal`, `*.db-shm`, `*.pmtiles`,
  `data/`, `fixtures/*.json`, `.env`, `CLAUDE.local.md`.
- **Never commit `node_modules`** — modules built on x86 don't run on ARM.
- Large data files are always fetched by script, never checked into the repo.

## Hard performance rules (Raspberry Pi 3, 1 GB RAM) — non-negotiable

1. **Never send the full `aircraft.json` to the browser.** Keep state in
   memory; send only deltas over WebSocket.
2. **One file read per second, regardless of client count.** All clients
   served from the same in-memory state.
3. **Round values before sending**: lat/lon to 5 decimal places, altitude to
   25 ft.
4. **SQLite gets events and daily aggregates only — never raw position
   history.** SD card cannot survive per-position writes.
5. **Batch writes in transactions every 30–60 seconds.** No per-row INSERTs
   in a loop. `server/src/db.js` sets `PRAGMA journal_mode = WAL` /
   `synchronous = NORMAL` right after opening the connection (v2.1.14) — WAL
   means a committed transaction appends to the WAL file instead of a
   rollback-journal file being created/fsynced/deleted every time, and
   NORMAL is WAL's documented synchronous pairing (still fsyncs at
   checkpoints, not after every transaction). `runBatch` (exported, wraps a
   function in one transaction) is **reentrant via `SAVEPOINT`**: node:
   sqlite's `DatabaseSync` throws on a literal nested `BEGIN`, but
   `index.js`'s `flushDailyStats` calls `upsertDailyStats` plus four
   `flushDirtyX()` functions together, several of which reach one of
   `db.js`'s own `upsertX` helpers that call `runBatch` on their own — a
   depth counter means only the outermost call opens/closes the real
   transaction (five commits per flush tick down to one) while every call
   still commits-or-rolls-back correctly standalone. The all-time max-range
   record (`notifications/rules.js`) used to write straight to SQLite from
   the per-second poll loop on every improved record — a real burst on a
   fresh install, since nearly every tick can beat a not-yet-established
   record. Now an in-memory cache + dirty flag
   (`flushAllTimeMaxRangeKmIfDirty()`, called from the same periodic tick as
   `flushDailyStats`, and the shutdown path that already calls it too) —
   `getAllTimeMaxRangeKm()` reads the cache directly, so Stats/the
   notification still see an improved record immediately; only the SQLite
   write itself is deferred, same "an in-flight value can be lost on an
   untimely restart, same as everything else under hard rule 6" tradeoff
   already accepted for the daily accumulator.
6. Current state lives in RAM only. A service restart losing live state is
   acceptable and expected.
7. **No Docker.** Install via systemd + a plain script.
8. Backend budget: **up to 150 MB RSS**. systemd unit sets `MemoryMax=300M`
   and `NODE_OPTIONS=--max-old-space-size=192`.
9. The `hex -> aircraft` map must not grow unbounded — evict aircraft unseen
   for a few minutes.

## Stack

- Backend: Node.js (>=22.13.0) + Fastify + `ws`.
- Storage: built-in `node:sqlite` — zero native compilation.
- Frontend: plain JavaScript (ES modules) + MapLibre GL JS. **No framework,
  no build step.** Static files served directly by Fastify.
- Basemap: two modes, switchable in Settings → Map (`basemapMode`,
  `public/js/settings-state.js`), **online is the default**:
  - **Online**: OpenFreeMap (`https://tiles.openfreemap.org`) vector tiles —
    no API key/signup/rate limit. `public/mapstyles/online-dark.json` is our
    own MapLibre style spec against their `openmaptiles`-schema source (~20
    curated layers). Keep in sync by hand if OpenFreeMap changes their
    schema — it intentionally does not inherit from their ready-made styles.
  - **Offline**: Natural Earth 1:10m GeoJSON, ~20 MB, public domain. Fetched
    by `scripts/fetch-mapdata.sh` at install time — never committed.
  - **Map theme** (`mapTheme`, default `light`, values `light`/`dark`/
    `auto`): independent of `basemapMode`. `auto` follows sunrise/sunset at
    the receiver — `app.js`'s `resolveMapTheme` resolves it before anything
    else sees it. Server-side decision (`server/src/daylight.js`, standard
    sunrise equation), `GET /api/daylight` → `{ isDaylight }`, deliberately
    **not** behind `requireSettingsAuth` (every browser needs it) and a bare
    boolean (never hands out coordinates). `isDaylight: null` = no home
    configured, client falls back to OS `prefers-color-scheme`. Re-checks
    every 10 minutes. **Watch the longitude sign** if touching `daylight.js`:
    `lon` is east-positive here, solar noon is `n - lon/360` (textbook
    formulas are west-positive and read `+ l_w/360` — getting this backwards
    shifts results by twice the offset; solstice tests catch it). This is
    **map-only** theme — the app's own UI (bottom bar/panels/settings) stays
    dark always, deliberately, night-readable regardless of the map. Online
    light mode is `online-light.json`, structurally identical to
    `online-dark.json` (only `paint` colors differ) — keep in sync by hand.
    Offline light mode reuses the same GeoJSON layers with different paint
    values from `OFFLINE_PALETTES` in `basemap.js`.
  - Switching modes calls `map.setStyle(...)` (`public/js/basemap.js`'s
    `applyBasemapMode`) — no page reload. Because `setStyle` wipes all
    sources/layers, the trail source/layer and offline GeoJSON layers are
    re-added on the `style.load` event every time.
  - **Session-scoped auto-fallback**: if online can't be reached (preflight
    TileJSON fetch fails, or an `error` event looks like a network failure),
    `basemap.js` switches to offline for the rest of that browser tab and
    won't retry online until reload. The persisted `basemapMode` setting is
    untouched. Settings shows a notice when active. `armOnlineErrorWatch` is
    armed once per map instance and reads module-level `currentTheme`/
    `currentCallbacks` at fire time (not closed over at arm time) — don't
    reintroduce a closure over theme here (caught by a mock-`map` unit test).
  - **Attribution**: OSM data is ODbL-licensed, requires attribution.
    Default `AttributionControl` disabled; custom `#mlpr-attribution` div
    with a "MapLibre" credit (always shown) and `#mlpr-osm-attribution`
    (shown only while effectively online), toggled by
    `updateAttributionVisibility()`. Required exact text per OpenFreeMap's
    docs: "OpenFreeMap © OpenMapTiles Data from OpenStreetMap" (each name
    individually linked — three separate parties, not just OSM).
    `#mlpr-attribution` needs its own explicit `color` (plain text sits
    between links, unlike an all-link version that never needed one).
    MapLibre GL JS itself (BSD-3-Clause) does **not** legally require an
    on-map credit, included anyway per request. Offline mode needs no data
    attribution.
    Position: bottom-left (`bottom: 6px`) on screens `>=720px`; below that,
    raised above the bottom bar to avoid colliding with the List pill
    button, and below 720px it moves to the **top-right** corner instead
    (busiest UI is at the bottom of a phone screen). Any corner is
    acceptable per OSM's own attribution guidelines — moving corners is not
    a license constraint, purely to dodge overlaps with other UI.
    **Credits panel byline**: "MLPR v<version> by Maurycy Kaczmarek", links
    to the GitHub repo. Version from `GET /api/version` (reads
    `package.json`, ungated).
- Icons: inline SVG only, authored in-repo. No icon libraries, fonts, or
  CDNs — everything must work fully offline.

## Networking

- Default port **1090** (nod to 1090 MHz), configurable via `MLPR_PORT`.
  Never use 8080, 8085 (other apps on this host) or 30001–30005 / 30104
  (readsb's ports).
- Bind `0.0.0.0`, local-network access.
- App root `/` serves the interface directly.
- No authentication (home LAN app). But **never expose an endpoint that runs
  system commands**, in case this ends up reachable from outside.
- Every response carries `X-Frame-Options: DENY` and `X-Content-Type-Options:
  nosniff` (one `onSend` hook in `server.js`, no dependency).
- **WebSocket reconnect has exponential backoff, and a status pill tells the
  user when it's down** (`app.js`'s `connect()`, v2.1.14). Before this, a
  dropped connection retried on a flat `setTimeout(connect, 1000)` forever
  (one request a second indefinitely against a downed server) with nothing
  telling the user why the map had frozen — hit more than once during
  development as "the whole page died" when the real cause was just the
  server being restarted. `reconnectDelayMs` doubles on each consecutive
  failed attempt up to `MAX_RECONNECT_DELAY_MS` (30s), reset back to
  `INITIAL_RECONNECT_DELAY_MS` (1s) on the socket's own `'open'` event (not
  the first message — `'open'` fires on the handshake itself, before the
  server's first snapshot even arrives). `#mlpr-connection-status`
  (`index.html`, hidden by default, `role="status" aria-live="polite"`) is a
  red pill (the one alarming color in this app's palette — see the dark
  theme note below) shown only while `setConnectionStatus(false)` has been
  called more recently than `setConnectionStatus(true)`; reused for the very
  first connection attempt too, so a server that's down when the tab loads
  shows the same message rather than a silently frozen map.

## UI

- One URL, one responsive interface — no separate mobile build. Works on
  phone (portrait), laptop, and a wall-mounted big screen.
- Auto-detects browser/system language; ships Polish + English at launch.
- Full-screen map, bottom bar with three small labeled icon buttons (inline
  SVG, translated label via `t()`, semi-transparent pill background):
  **List**, **Stats**, **Settings**.
  List (`public/js/list.js`) shows a total-aircraft count above the table
  (always live unfiltered, not search-filtered), highlights the row
  matching `selectedHex` (`app.js`'s own source of truth, mirrored into
  `radar-state.js`'s `setSelectedHex`/`getSelectedHex` for other modules to
  read — distinct from `setInspectedHex`/`getInspectedHex`, "whose full
  details panel is open"). Search box matches flight/callsign, hex, type,
  registration; lives outside the subtree `drawTable()` rebuilds each
  redraw, so typing doesn't lose focus. Sorting compares `sortValue()`'s raw
  values (real number, `-1` for on-ground so it always sorts lowest, `null`
  for missing data always sorts last), **not** `formatCell()`'s display
  strings.
  **Mode-S-only contacts (no ADS-B position) are shown**, flagged with a
  crossed-out pin icon (`NO_POSITION_ICON`) rather than omitted —
  `applyAircraftUpdate` splits into `noteAircraft` (always runs, feeds
  List/Stats/counts) vs. marker-placement (still gated on having a real
  position). A position lost mid-flight leaves the existing marker in place;
  regular fade/forget timers retire it if position never returns.
- **List columns and sort order are user-configurable**: "Configure" button
  swaps the table view for an in-place config view. **Every edit
  auto-saves** — no Save/Cancel step. Column and sort-level rows both have
  ↑/↓ reorder + Remove (disabled at one remaining column/level).
  Persisted per-browser in `settings-state.js`: `listColumns` (ordered
  `list-fields.js` keys), `listSortLevels` (ordered `{key, asc}`, VRS's
  fixed 3-line sort generalized to any number of levels), `listPositionFirst`
  (known-position aircraft sort first). Defaults match the old fixed
  4-column layout (`flight`/`typeCode`/`altBaro`/`gs`) exactly.
  Desktop layout has three presentations depending on context
  (`list.js`'s `currentMode()`): `'floating'` (normal desktop — Configure
  renders into a separate sibling element, `#list-config-window`, glued to
  `#panel`'s left edge, never touching `#panel` itself), `'inline'`
  (fullscreen modal, wide enough — nested left of the table via
  `row-reverse`), `'swap'` (mobile bottom sheet — replaces the table in
  place). One `ResizeObserver` on `container` drives both floating
  repositioning and inline width measurement. Toggle closed by re-clicking
  Configure or the window's own `✕`. Visually the two read as independent
  windows (shared card styling), not one panel with two columns.
  `list-fields.js` is a flat field catalog shared with the aircraft details
  panel's tile groups, plus `distance` (home → aircraft) and `military`
  (always-visible boolean column here vs. hidden-unless-true tile there).
  "Open fullscreen" button opens the same `renderListPanel` view in
  `FULLSCREEN_MODALS.listFull`; inside fullscreen it becomes "Exit
  fullscreen" (`openPanel('list')`).
  `PANELS.list`/`FULLSCREEN_MODALS.listFull` (and, since 2026-08-01, every
  panel/modal) carry `fill: true` → `mlpr-panel-fill` class so the
  panel/modal reaches the true screen bottom instead of leaving a gap where
  the map is visible behind the bottom-bar pills.
- **The side panel's width is drag-resizable** via `#panel-resize-handle`
  (>=900px layout only). `#panel` is right-docked, so width is computed from
  the fixed right edge minus current pointer X. Persisted as
  `sidePanelWidth` (default 440, matches old hardcoded value), clamped to
  `[320, min(900, viewport width − 40)]`. Applied only when
  `matchMedia('(min-width: 900px)').matches` — an inline style would
  otherwise pin the mobile bottom sheet to a fixed pixel width. Shared
  `#panel` chrome — Settings and aircraft-details get it for free too.
- List and Settings are bottom sheets on phones, a side panel on large
  screens; closable via X, back-gesture, overlay click, or **Escape**
  (`panels.js`'s top-level `keydown` listener, reuses the same close
  functions the X button uses).
  **Stats is a full-screen view instead** (`#fullscreen-modal`,
  `FULLSCREEN_MODALS` registry, separate from `PANELS`) — more room for its
  growing set of options, but the bottom bar stays reachable. `panels.js`
  treats "a history entry is pushed" and "something is open" as one shared
  fact across both mechanisms — switching directly between panel/modal
  (e.g. List → Stats) must not push/pop history, only actually
  opening/closing should (getting this wrong makes a newly-opened view
  self-close, because closing the other one first fires an async
  `history.back()` after the new one already pushed its own entry).
- **Accessibility**: `<html lang>` and every close/bottom-bar button's
  `aria-label` are set from the same `t()` source as the visible label
  (`panels.js`, evaluated before `app.js`'s own map construction, so it runs
  even if WebGL fails). Opening a panel/modal moves focus to its close
  button and traps Tab/Shift+Tab (`trapFocus`); closing restores focus to
  whatever had it before — captured only on a genuine closed→open
  transition, not a direct panel/modal switch.
- **Manual language override** (`language` in `settings-state.js`, default
  `'auto'`): `i18n.js`'s `detectLanguage()` checks this before
  `navigator.language`. Applying a change is a `location.reload()`, not a
  live re-render — translations are baked into static markup at render
  time. Language `<select>` options show their own native name
  ("English"/"Polski"), not run through `t()`.
- **`.mlpr-info-icon` tooltips are real `<button>`s, not
  `<span tabindex="0">`** — some mobile browsers don't reliably move focus
  to a plain focusable span on tap, which the CSS `:hover`/`:focus` tooltip
  reveal depends on.
- **Dark theme is the default** — night-readable radar display. Color
  theme: green, blue, black.
- **Plane icon rotates to heading, derived when `track` is missing**
  (`public/js/geo.js`'s `deriveHeadingDegrees`, called from `app.js`'s
  `applyAircraftUpdate` right before `state.lastLngLat` gets overwritten
  with the current update's position — needs the *previous* one).
  `aircraft.track` can be absent on an otherwise-good position update, the
  same failure mode documented above for missing altitude — reported live
  as a marker snapping to due north (`setPlaneHeading`'s own fallback for a
  non-number) instead of its real course, most visibly right after an
  aircraft reappears from a signal gap. Rather than carrying the last
  *reported* track forward (the altitude fix's approach), this derives a
  bearing from the aircraft's own actual displacement (last known position
  → new position) — correct even if the aircraft turned during the gap,
  which carrying forward a stale track value would get wrong.
  **The noise floor is source-aware, not a flat distance check** — an ADS-B
  hop is trusted at any distance (position error is tens of metres, straight
  from the aircraft's own GPS); only an MLAT hop under
  `MLAT_MIN_HEADING_DERIVATION_DISTANCE_KM` (0.3 km, same figure/reason as
  `trail.js`'s `MLAT_MIN_TURN_CHECK_KM` — MLAT's triangulated error is
  commonly 100-500 m) returns `undefined` rather than trust the noise,
  falling back to the pre-existing due-north default. A first version
  applied that 0.3 km floor unconditionally (copied from trail.js for
  consistency, not re-derived for this use case) — caught before shipping:
  a normal 1 Hz poll only covers ~55-250 m of real displacement at typical
  aircraft speeds, so the flat floor silently suppressed the derivation for
  its main target, a single missing track field mid-flight on an
  otherwise-good ADS-B update.
  **When `deriveHeadingDegrees` itself can't derive or trust anything
  (returns `undefined`), `app.js` falls back to the last confidently-known
  heading** (`state.lastHeadingDegrees`, carried across ticks — only ever
  overwritten with a real number, never with `undefined`, so it survives
  however many ticks in a row have nothing usable) **before** falling
  further back to `setPlaneHeading`'s own due-north default. Same
  carry-forward idea as the altitude fix above, applied to heading instead
  of color — a stale-but-plausible heading is a strictly better guess than
  snapping to north, and north is only ever shown for an aircraft with no
  confidently-known heading yet at all (e.g. its very first tick).
  **A zero-displacement hop returns `undefined`, not a bearing** (v2.1.15) —
  `bearingDegrees` answers a point-to-itself query with `0`, which is
  indistinguishable from a genuine northbound course, and this is the exact
  case a signal loss produces: readsb re-reports the last known `lat`/`lon`
  while its own `track` field ages out of the JSON first, so a fading
  aircraft reliably arrives here with a frozen position and no track. That
  `0` also defeated the carry-forward above — being a number, it was
  accepted *and cached* into `state.lastHeadingDegrees`, so once an aircraft
  snapped north it stayed north for good. Deliberately an exact-equality
  check, **not** a minimum distance: an ADS-B distance floor was already
  tried and was wrong (see above), and lat/lon are rounded to 5 decimals
  server-side, so a genuinely repeated fix compares exactly equal.
- Click shows trail + basic info popup with a
  "show more details" button opening the full aircraft details panel
  (`PANELS.aircraft`, opened via `openPanel('aircraft')` after
  `setInspectedHex(hex)`). Popup offset:
  `Math.round(aircraftIconSize / 2) + 7`, not a fixed constant. `showInfoPopup`
  **reuses the existing popup instance** (`setLngLat`/`setHTML`) when it's
  already showing the selected aircraft, tracked via module-level
  `activePopupHex`. Constructed with **`focusAfterOpen: false`** — MapLibre's
  `setDOMContent()` (called by every `setHTML()`, including the reuse path)
  calls `_focusFirstElement()` unconditionally unless this option disables
  it; an earlier fix only addressed the `.addTo()` path and still stole
  focus from any open `<select>` on every tick. If this class of bug shows
  up again, grep the installed `maplibre-gl` source for
  `_focusFirstElement` rather than re-guessing.
  `formatAircraftInfo()`'s output is **HTML-escaped** before `setHTML()` —
  `HttpSource` fetches over unauthenticated LAN HTTP, so an unescaped
  callsign is a real stored-XSS path. `escapeHtml` itself lives in
  `public/js/html-escape.js` (v2.1.14) — one shared module in the same
  spirit as `geo.js`/`debounce.js`/`pending-queue.js`, replacing three
  identical copies that had accumulated in `app.js`, `stats.js` and
  `aircraft-panel.js`.
  Popup content: bold callsign header, a `.mlpr-popup-chips` row reusing
  `aircraft-panel.js`'s chip markup, a `.mlpr-popup-badge` pill for "on
  ground". Styled via `.maplibregl-popup-content` directly (this app only
  ever shows one kind of popup); tip/close-button overrides per anchor
  direction since MapLibre auto-picks the anchor corner. `:root
  { color-scheme: dark }` (added for native checkboxes) means any element
  relying on inherited text color without setting its own resolves to a
  *light* default — a recurring bug pattern in this app (also hit the
  OpenFreeMap attribution div and the polygon-editor's config window), so
  always set explicit `color` on anything that could sit against an
  unstyled/white background.
- **Aircraft icon shapes and classification** (`public/js/plane-icons.js` +
  `icon-classify.js`): 17 hand-drawn top-down silhouettes
  (`PLANE_ICON_IDS`), each a single `<path fill="currentColor">` in a shared
  24x24 viewBox. `icon-classify.js`'s `classifyIconKind(aircraft)` — fixed
  chain: typeCode `'TWR'` → military-table override → own type table
  (`data/icon-types.json`, exact-then-longest-prefix) → ADS-B `category`
  field → `'unknown'` fallback. This algorithm is final; only the type
  table's coverage keeps growing (`/dev/icon-types`, `/dev/icon_verify`).
  `NON_ROTATING_ICON_IDS` (balloon/tower/drone) always render upright
  regardless of `track` — none has a meaningful "nose direction".
  `public/js/aircraft-icon-live.js` is the production adapter `app.js`
  imports, wrapping `classifyIconKind`/`getIconPath` behind
  `createPlaneElement`/`setPlaneKind`/`setPlaneHeading`/`setPlaneColor`/
  `setPlaneLabel`. `icon-types.json` is fetched once inside `app.js`'s
  `map.on('load', ...)`, before the first queued snapshot is classified.
  `/dev/icons` (dev-only) browses every shape/rotation/size combo and
  tests the classification chain live; `/dev/icon-types` (dev-only) is a
  filterable table over the JSON, flagging low-confidence entries
  (`_needsVerification`). `/dev/icon_verify` is **available in
  production** (needs real receiver traffic) — runs every registration this
  install has ever seen through the real classification chain, highlighting
  unresolved (`unknown`) results.
- **Icon size is user-adjustable** (`aircraftIconSize`, default 40px,
  Settings → Aircraft slider, 24–64px), applied via CSS custom property
  `--mlpr-plane-size`. Each marker also gets its own inline override
  (`refreshMarkerSize`) equal to the slider value times that icon kind's own
  multiplier (`ICON_SIZE_MULTIPLIERS`, e.g. widebody 1.25x, drone 0.8x).
  Popup offset uses the plain slider value, not the per-kind multiplier — a
  known, accepted imprecision.
- **Marker color has three mutually-exclusive modes** (`planeColorMode`,
  default `signalLoss`): `signalLoss` fades green→red the longer since last
  update (the only mode tied to elapsed time — periodic redraw only
  recolors for staleness in this mode); `altitude` reuses `trail.js`'s
  `colorForAltitude`; `speed` is a green→yellow→orange→red gradient over
  ground speed (`colorForSpeed`, `aircraft-color.js`) — deliberately never
  touching blue/violet so it doesn't read as an altitude-scale variant.
  `colorForElapsed`/`colorForSpeed` live in `public/js/aircraft-color.js`,
  not `app.js` (which instantiates `maplibregl.Map` at module scope and
  can't run under plain `node --test`) — kept unit-testable
  (`aircraft-color.test.js`). Shared HSL gradient math
  (`colorFromStops`) lives in `public/js/color-gradient.js`.

### Aircraft details panel (`public/js/aircraft-details.js` + `aircraft-panel.js`)

Split deliberately: `aircraft-details.js` is pure data-shaping, **zero
DOM/browser dependency**, testable with plain `node --test`
(importing `i18n.js`/`radar-state.js` at module scope would crash under
plain Node). `aircraft-panel.js` does DOM rendering, translation, and the
Planespotters photo fetch.

- Fields tiered: `core` (always visible) and `extra` (behind "show more
  fields", ordered most-to-least interesting).
- A field with no data produces no tile — never a blank/dash placeholder.
- `cluster` entries (e.g. `gs`/`ias`/`tas`/`mach`) render as a labeled
  full-width row of inline chips, only chips that have data.
- `pairId` groups two independently-optional fields side by side (e.g.
  altitude/vertical rate); `reorderForPairing` matches pairs explicitly and
  promotes an unpaired survivor to full-width — **don't rely on plain array
  adjacency**, it drifts as soon as an earlier tile is filtered out.
- Boolean flags (`military`/`interesting`/`pia`/`ladd`/`alert`/`spi`) only
  produce a tile when `true`.
- **Photo**: fetched client-side (never proxied through our server — see
  `THIRD_PARTY.md`) from Planespotters' free Photo API by ICAO hex. No
  photo / fetch failure = no photo section, never an error shown. Headless
  browsers get Cloudflare-blocked (403) — that's automation, not a broken
  integration. Photo is fetched once per panel open, tiles redraw on every
  `radar-state.js` change (matching `list.js`'s pattern).
- **`radar-state.js`'s aircraft mutators (`noteAircraft`/`removeAircraft`/
  `clearAircraft`) are deliberately silent** — no `notify()` call. `app.js`
  applies a whole batch (one WS delta, or one forget-tick) then calls
  `notifyAircraftChanged()` exactly once — per-aircraft notification used to
  rebuild `list.js`'s entire `<table>` dozens of times a second under load.
  Any new caller mutating `liveAircraft` must remember to flush afterward.
- Trail color follows altitude, smooth HSL gradient (`ALTITUDE_STOPS` in
  `trail.js`): golden green at ground, pure green by 10,000 ft, blue by
  17,500 ft, violet/magenta to red at 30,250 ft, dark red at 40,000 ft.
  Interpolated in HSL deliberately — plain RGB lerp between different
  hue+lightness passes through desaturated mud (regression tests assert a
  saturation floor and that a 3,000 ft step is visibly distinct color —
  don't switch any leg back to plain RGB). These exact stop values came from
  the user comparing rendered side-by-side gradients — regenerate
  comparisons the same way if retuning, don't guess numbers.
- Signal loss: no update for 3s → fading toward red; fully red by 10s, stays
  fully red another 10s, removed at 20s (`FADE_START_MS`/`FADE_END_MS`/
  `REMOVE_MS`). Reappearing draws the gap segment grey **and dashed**
  (`GAP_COLOR`, fixed neutral, same in both themes). Gives up after 5
  minutes with no update.
- **Map label under each aircraft** (`setPlaneLabel`/`buildAircraftLabel`):
  configurable per-field (`aircraftLabelFields`, default flight/hex only). A
  field with no data contributes nothing; all-empty collapses to an empty
  string, hidden entirely via `.mlpr-plane-label:empty`. Rendered as a
  sibling div of the `<svg>` (not inside it), so it never spins with
  heading. Colors follow the **map's** resolved theme, independent of the
  app's always-dark UI. Hidden below `LABEL_MIN_ZOOM` (7) via one class
  toggle on the map container.
- **Selection and hover are visually distinct on every axis**, from each
  other and from the plane-color modes — color is already spoken for by
  `planeColorMode`.
  - **Selected** (`.mlpr-plane-selected`): a soft breathing **achromatic**
    halo (`.mlpr-plane-glow`, background div painted behind the `<svg>` via
    DOM order) — white on dark map theme, black on light. A background glow
    (not a filter) because animating `opacity`/`transform` is more reliably
    smooth than `filter`, which hover uses instead — deliberately a
    different technique so the two never read as variants of one effect.
    Persistent until explicitly cleared.
  - **Hovered** (`.mlpr-plane-hover`): a crisp amber `drop-shadow` ring on
    the `<svg>`'s own silhouette, not animated, amber because unused
    elsewhere in the palette. Two-way cross-highlight with the List panel,
    each direction a different mechanism: Map→List uses `radar-state.js`'s
    **separate** `onHoverChange` listener set (kept apart from the main
    `onChange` channel so mouse movement doesn't trigger table rebuilds);
    `list.js`'s `updateHoverHighlight()` only toggles a class on existing
    `<tr>`s. List→Map uses a direct `requestHover(hex|null)` request/handler
    pair (one map, one global handler).
- **Trails are always on**, `trailMode` (Settings → Map) chooses `click`
  (selected aircraft only, default) or `all`. No way to disable trails
  entirely (removed as redundant UI) — if wanted back, should be a third
  `trailMode` value (`off`), not a second setting. The grey signal-loss
  segment and altitude-colored segments are the same per-hex feature list
  (`isGap` flag) rendered into one shared GeoJSON source feeding **two**
  layers — `mlpr-trail` (solid) and `mlpr-trail-gap` (dashed) — forced by
  MapLibre's `line-dasharray` not being data-driven. Never go back to a
  separate always-populated gap source (drew grey trails for unselected
  aircraft that never cleared).
- **Trail geometry is built as merged per-color runs**, not one 2-point
  LineString per sample (`trailFeaturesFor`). Altitude quantised into 200 ft
  bands (`ALTITUDE_BAND_FT`) so steady-altitude samples collapse into one
  polyline. Combined with `line-cap: round` and `tolerance: 0` on the source
  (disabling geojson-vt simplification) — both needed, they fix different
  halves of "trail looks dashed when zoomed out."
- **A trail point with no barometric altitude carries the previous point's
  altitude forward for coloring, at render time only** (`trail.js`'s
  `carryForwardAltitude`, applied inside `trailFeaturesFor` before the MLAT
  passes below — stored history keeps whatever was actually received,
  undefined included). A weak/fringe decode can drop the altitude subfield
  while lat/lon still checksum, often right as an aircraft is about to lose
  contact — `colorForAltitude`'s "unknown altitude = ground" fallback is
  correct for a contact with no altitude at all (e.g. Mode-S-only), but
  applied to a single missing tick mid-cruise it painted a solid
  golden-green "ground level" segment (reported live, screenshot showing a
  bright yellow trail exactly where a plane was fading out) instead of
  either holding the previous cruise color or going dashed grey. Only
  applies when there's a real prior altitude to carry — a trail with no
  altitude ever (from the first point) still falls back to ground, unchanged.
- **The marker fade/removal timer (`FADE_START_MS`/`FADE_END_MS`/
  `REMOVE_MS`) and the trail-gap flag on reappearance are keyed off position
  freshness (`aircraftState`'s `lastPositionAt`), not "any update at all"**
  (`lastUpdateAt`, used only for the signalLoss color fade itself, per its
  own doc above). A Mode-S-only ping (no decodable position) still refreshes
  `lastUpdateAt` and `noteAircraft` — a real contact, correctly kept visible
  to List/Stats — but `applyAircraftUpdate` deliberately leaves
  `lastPositionAt`/`goneAt` untouched on that path. Before this fix both
  timers read `lastUpdateAt`, so a run of position-less pings (readsb can
  report Mode-S traffic for a while with no decodable position) kept
  resetting the removal clock indefinitely: the marker just sat frozen at
  its last known spot — never fading, never removed, `goneAt` never set —
  however stale the position actually was. When a real position finally
  came back, `wasGone` read `false` (it had been getting reset to `null` by
  every position-less tick in between), so the trail joined the old frozen
  point straight to the new one with a normal colored segment instead of a
  dashed gap — reported live as a plane appearing to freeze then jump to a
  new spot with a plain/yellow line, not a dashed one, distinct from the
  missing-altitude bug above (this one can happen with a perfectly good
  altitude reading on both sides). An aircraft never yet plotted at all has
  `lastPositionAt === null` and is skipped by this check entirely — nothing
  to fade or remove.
- **A repeated *stale* position must not refresh `lastPositionAt` either**
  (`aircraft.seenPos`-gated, v2.1.14) — a second, distinct bug from the one
  directly above, same symptom (reported live, with screenshots: long
  orphaned trail segments with no marker anywhere near either end, clearing
  only after a much longer delay than the usual ~20s). readsb keeps
  reporting an aircraft's *last known* `lat`/`lon` for a while after it
  actually stops decoding fresh fixes — its own aging-out window is commonly
  much longer than `REMOVE_MS`. As long as some *other* field (altitude,
  speed, track) keeps legitimately changing from ongoing Mode-S traffic,
  `server/src/state.js`'s `hasChanged` still resends this aircraft every
  tick (`lat`/`lon` are themselves in `CHANGE_FIELDS`, but comparing equal
  doesn't block a resend some *other* tracked field triggers), each time
  carrying the exact same frozen `lat`/`lon` — confirmed directly against
  the live receiver (a WebSocket probe, no raw data persisted anywhere):
  one aircraft's position stayed byte-identical for 3+ consecutive ticks
  while `altBaro`/`messages` kept advancing, `seenPos` climbing the whole
  time. Since `applyAircraftUpdate` only checked "is `lat`/`lon` present,"
  not "is it fresh," this silently postponed `REMOVE_MS` for as long as the
  repeats continued — potentially far longer than readsb's own retention
  window plus 20s, matching the reported delayed clearing exactly.
  `aircraft.seenPos` is readsb's own "seconds since this position was last
  actually decoded" counter (already normalized, `server/src/normalize.js`).
  **Every position is *aged* by it rather than tested against a
  fresh/stale threshold** (v2.1.15 — v2.1.14 shipped a
  `POSITION_STALE_THRESHOLD_S` boolean, since removed):
  `lastPositionAt = now - seenPos*1000`, and it only ever moves **forward**.
  A repeated stale fix carries a *growing* `seenPos`, so it keeps resolving
  to the same original decode instant and postpones nothing — the same
  protection the boolean gave. What the boolean got wrong was the other end:
  it left `lastPositionAt` at `null` whenever the *first* position ever seen
  for an aircraft was already stale (a tab opened, or a WebSocket
  reconnect's full snapshot arriving, while that aircraft was
  mid-signal-gap), and the periodic tick's removal check skips a `null`
  `lastPositionAt` as "never plotted, nothing to retire" — so **that marker
  and its trail stayed on the map forever**, which is the v2.1.14 regression
  reported live (an aircraft whose own details panel read "last position
  60 s" still sitting on the map, three times past `REMOVE_MS`). A position
  already older than `REMOVE_MS` is now never plotted at all, and never
  resurrects an already-retired marker. Missing `seenPos` (an older readsb
  build, a fixture without it) reads as age zero — the pre-existing
  behavior of trusting whatever is on offer. A position *inside* the window
  is still plotted stale or not (it's the best on hand, and repeating the
  same coordinates is a visual no-op anyway); only the clock is aged.
- **`isCurrentlyTracked` requires a live marker, not just `goneAt === null`**
  (v2.1.15) — the other half of "trails left on the map with no aircraft."
  A state can exist with no marker at all: an aircraft the receiver still
  hears over Mode-S but can no longer place, or one whose only reported
  position was already too stale to plot. Its trail history is not
  necessarily empty, because `loadAllTrails()` seeds it straight from the
  server (`GET /api/trails`) the moment the tab opens — so a freshly-opened
  tab drew a full server-side trail with nothing at the end of it, and,
  since the removal tick had no marker to retire and so never set `goneAt`,
  nothing could ever clear it. Relatedly, a **full** snapshot now always
  calls `renderTrail()`, not only when it recorded a trail point of its own:
  `resetAll()` has just dropped every `aircraftState` entry while the trail
  source still holds the *previous* set's `FeatureCollection`, so a
  reconnect landing on an empty sky would otherwise leave those trails
  painted with no aircraft anywhere.
- **MLAT-derived trail points get anomaly-filtered and smoothed; ADS-B
  points never do** (`trail.js`'s `filterMlatAnomalies`/
  `smoothMlatPositions`, applied inside `trailFeaturesFor`, so both
  server-seeded history and live WS points get the same treatment). Every
  point carries `isMlat` (`sourceType === 'mlat'`). `filterMlatAnomalies`:
  single oldest-to-newest pass, ADS-B points/gaps always kept and become the
  reference; MLAT points judged against the two most recent *accepted*
  points, dropped if implying unrealistic speed
  (`MLAT_MAX_SPEED_KMH` ~1200 kt) or turn rate
  (`MLAT_MAX_TURN_RATE_DEG_PER_SEC` 10°/s), turn check skipped when either
  leg is under `MLAT_MIN_TURN_CHECK_KM` (300 m — positional noise alone can
  imply a huge bearing swing over a short distance). `smoothMlatPositions`
  runs second: weighted 3-point moving average (`prev + 2×point + next / 4`)
  — only moves MLAT points, ADS-B points are trusted anchors but never
  modified, endpoints/near-gap points left alone. Both passes are cheap
  no-ops on an all-ADS-B trail.
- **Trail history is server-side** (`server/src/trail-history.js`), an
  in-memory (never SQLite — hard rule 4) capped ring buffer per hex,
  recorded every poll tick, evicted when a hex leaves `state.js`'s tracked
  set. `GET /api/trails/:hex` and `GET /api/trails` (bulk) seed a
  freshly-opened tab immediately; the client keeps extending live from WS.
- Right-click-drag map rotate/tilt is disabled — permanently north-up and
  flat, per explicit request.

### Settings scope: per-browser vs. shared (load-bearing)

The Settings panel has five tabs, and **which tab something lives on encodes
where it is stored**:

| Tab | Contents | Stored |
|---|---|---|
| General | units, language | `localStorage` |
| Map | basemap mode, map theme, trails | `localStorage` |
| Aircraft | marker color mode, icon size, altitude filter | `localStorage` |
| Notifications | notification rules, ntfy topic, watch list, smart home | SQLite (shared) |
| Server | Settings password, server port, receiver location | SQLite (shared) |

Smart Home was folded into Notifications (was its own sixth tab, overflowed
the tab row sized for five). The merged tab shows rule toggles plus two
buttons — **Configure notifications** and **Configure smart home** — each
opening a subview in place, with a Back button. **The access-control split
is unchanged and is the thing to be careful about when touching this**:
smart home still checks `passwordSet && !getStoredToken()` internally
(broker credentials are a real infra secret), while rule toggles/ntfy
topic/watch list stay ungated. Sharing a tab must not become sharing a gate.

- **Per-browser** settings live in `settings-state.js` (`localStorage`).
- **Shared** settings live server-side in SQLite, reached over `/api/*`.
- **The receiver location lives on the Server tab, not Map** — no sensible
  per-browser answer to "where is the receiver," and it sits with the other
  server-level, password-gated controls. Each tab carries a
  `.mlpr-scope-note` banner stating whether it's per-browser or shared —
  keep accurate if anything moves.

**Server port** (`server/src/server-config.js`): resolution order is
`MLPR_PORT` env > stored config > 1090; `GET /api/server/port` reports which
is in effect. Changing it persists but **does not rebind the running
server** — `Restart=on-failure` means exiting would just stop the service,
so the UI tells the user to restart manually. `validatePort` rejects below
1024, readsb's own ports, and 8080/8085. Saving requires `window.confirm`
stating the exact new address — a heavier gate than usual, since mistyping a
port on a headless Pi can lock you out. Config backup/restore uses the same
gate for the same reason.

**Config backup/restore** (`server/src/config-backup.js`, Server tab
"Backup"): full export/import of everything in SQLite's `config` table in
one JSON file. Generic over the table's raw-string/JSON-blob mix
(`getAllConfigEntries`) — export/import round-trip every value as an opaque
string, so the module doesn't need updating when a new config key is added
elsewhere. Import **merges** rather than wiping the table, so restoring an
older export can't delete a newer-version-only setting. `GET`/`POST
/api/settings/export`/`/import`, both gated behind `requireSettingsAuth` —
a deliberate exception to the usual scope, since the bundle includes the
password hash and smart-home credentials alongside the normally-ungated
notification settings. A successful import calls `reconfigureSmartHome()`
immediately; frontend just says "reload the page."

## Notification engine

Implemented in `server/src/notifications/`: `rules.js` (evaluation),
`cooldown.js` (per-`${ruleType}:${hex}` in-memory cooldown, default 30
min), `ntfy.js` (delivery), `settings.js` (enabled/disabled rules + ntfy
topic, persisted in SQLite `config`).

Live triggers: squawk 7500/7600/7700, first-time-seen aircraft (checked
against `seen_aircraft`, grows for the life of the install, bounded by
distinct aircraft ever seen — fine under hard rule 4) **delayed by
`FIRST_SEEN_DELAY_MS` (3s)** before notifying/writing — readsb can take a
tick or two to decode callsign/position, and firing immediately produced
notifications with fields still missing. `rules.js`'s `pendingFirstSeen`
map (hex → first-noticed timestamp, pruned hourly) tracks this; a hex that
never gets a second look within the delay never notifies and is never
written to `seen_aircraft`. `evaluateAircraftRules` takes an optional `now`
argument for deterministic tests; the real call site never passes it.

New all-time range record (compared against `allTimeMaxRangeKm` config) —
fed by MLPR's own per-tick Haversine calc (`bestRangeKm`,
`recordRangeAndRegistrationSightings`, `range.js`'s `distanceKm`,
MLAT-excluded via `isRangeEligible`), **not** readsb's `stats.json`
`total.max_distance` (see Range/position sampling below for why). A
**watch list** (`watchlist.js`): entries `{id, matchType:
type|registration|flight, matchValue, altitudeOperator: below|above|null,
altitudeValue, area}`, stored as JSON in `config`. Matching is
case-insensitive on `aircraft[typeCode|registration|flight]`; altitude
condition treats `onGround` as altitude 0, doesn't match if the needed data
is missing (never a false positive from missing data). Each rule has its
own enabled/disabled toggle. **Squawk and watch-list both have a per-hex
cooldown** (first-seen and range-record are naturally one-shot per
hex/record already).

**Receiver-silence watchdog** (`evaluateReceiverSilenceRule`): fires on the
*absence* of any aircraft at all — a receiver health check, unlike every
other rule which fires on presence of some condition. Called once per poll
tick with `Array.isArray(raw?.aircraft) && raw.aircraft.length > 0`,
computed **before** the `raw === null` early-return so a totally failed
fetch counts too. "Activity" means **at least one tracked hex, position or
not** — a Mode-S-only contact still proves the receiver is alive; requiring
a position would false-alarm in weak-MLAT areas. Threshold: flat **1 hour**
(`RECEIVER_SILENCE_MS`), not exposed as a setting — 5 minutes (an earlier
idea) is well within a normal quiet-traffic gap and would be a real
false-alarm source. State (`lastActivityAt`, seeded to process start;
`receiverSilenceNotified` latch) is in-memory only — a restart resets the
countdown, which reads as "the receiver just came back," reasonable right
after a restart. ntfy-only (no smart-home publish), modelled on the
range-record rule.

**Trigger area** (`area`, optional): `{kind: 'circle', lat, lon, radiusKm}`,
`{kind: 'rectangle', lat, lon, widthKm, heightKm}`, `{kind: 'polygon', lat,
lon, points: [{lat, lon}, ...]}`, or `null`. Matched by
`satisfiesAreaCondition` — area and altitude must **both** hold; no
position never matches. An unrecognised `kind` matches nothing (an
over-firing rule is worse than a silent one — this is what a newer-version
entry looks like after a downgrade). Shape-specific knowledge lives in
exactly three per-shape tables: `watchlist.js`'s `AREA_SIZE_FIELDS`
(validation + field-stripping in `normalizeArea`), `area-editor.js`'s
`HANDLE_SPECS` (resize handle positions), `geo.js`'s `shapeRing` builders.
Polygon opts out of `HANDLE_SPECS` — its handles are the vertices.

**Every shape is centre-anchored** (`lat`/`lon` plus its own size fields).
**Rectangle bounds derived with the same `destinationPoint()` calls on both
sides** — `rules.js` for matching, `geo.js`'s `rectangleEdges`/
`rectangleRing` for drawing — so "inside the box on screen" and "matches
the rule" cannot drift apart. Only four corners needed (a lat/lon-aligned
box is a true rectangle in Web Mercator). Longitude test handles a box
straddling the antimeridian (`west > east`). Dragging a rectangle handle
moves both opposite edges (`valueFromDrag` doubles it), keeping the box
centred.

**The centre is an arbitrary point, deliberately NOT the receiver's home**
— the use case is watching a specific piece of sky that isn't overhead.
`radiusKm` is the canonical stored unit regardless of display preference.

Drawn in a full-screen map editor (`public/js/area-editor.js`,
`#area-editor`). Its own top-level element, not a `FULLSCREEN_MODALS`
entry, because it's parameterised and resolves a value back (area / `null`
= cleared / `undefined` = cancelled). Runs its own short-lived MapLibre
instance via `basemap.js`'s `styleForSecondaryMap`, **without** touching
`applyBasemapMode`'s module-level fallback state (scoped to the one
long-lived main map). Circle geometry reuses `destinationPoint`/
`circleRing`. Centre pin and resize handles are draggable
`maplibregl.Marker`s; for the circle, drag bearing is ignored and the
handle snaps back due east on `dragend`. **The handle element is
deliberately 0×0** with the dot absolutely centred — a non-zero element
would offset the marker's anchor away from the visual dot.

**How each shape is created differs**: circle is click-to-place; rectangle
and polygon appear immediately at the map centre when their button is
pressed. A fresh polygon is a **hexagon**, so it reads as "reshape me"
rather than a finished shape.

**Polygon editing**: drag a vertex to move it; tap an edge to insert a
vertex there (screen-space hit-test, `map.project`,
`EDGE_HIT_TOLERANCE_PX` — a lat/lon threshold would make edges
progressively harder to hit further north); double-tap/double-click a
vertex to remove it; desktop right-click for a menu with the same removal
(disabled at the 3-vertex floor). **Double-tap is detected by hand from
consecutive `pointerdown`s, never native `dblclick`** — a draggable
`Marker` sets `pointerEvents: none` past 3px of drift (MapLibre's own
`clickTolerance`), so `click`/`dblclick` never reliably reaches the
element on touch. The drag-vs-tap distinction is measured in **screen
pixels from the vertex's own position** (`TAP_DRIFT_PX`, 12), not from
MapLibre's `dragstart` (which fires at 3px, well within normal
finger-holding jitter — read out of the installed `maplibre-gl` source,
not re-derived). **The map's own double-tap zoom must be muted
separately** (`suppressTapZoom`) since it answers off bubbled
touchstart/touchend on the canvas container independently of the vertex's
own `dblclick` listener — those events can't simply be stopped from
bubbling, since `Marker`'s own drag handler listens for the same bubbled
event.
**Touch removes a vertex by long press** (`LONG_PRESS_MS`, 450ms); the
right-click menu is desktop-only — on a phone it was a menu with exactly
one item. Read from the last `pointerdown`'s `pointerType`, not the
`contextmenu` event (a plain `MouseEvent` outside recent Chrome).
**A gesture that removes a vertex also mutes the map click that follows it**
(`MAP_CLICK_MUTE_MS`) — the completing press also lands a map click right
where the vertex used to be, which would insert a vertex straight back.
`map.on('click')` also ignores clicks whose target sits inside a marker
element.
**The vertex dot must be a real child element, not a `::after`** — a
pseudo-element generates no hit-test target, breaking both click and
MapLibre's own `element.contains(event.target)` drag gate.
`event.button` is **not** checked for the polygon interactions — either
mouse button counts, and so does a mixed pair.

**The back gesture closes the editor and only the editor**
(`public/js/history-overlay.js`) — the editor stacks a second history entry
on top of `panels.js`'s single one; `panels.js`'s `popstate` listener gives
it first refusal. Closing by any other route swallows the resulting
`popstate` (via a flag) so it doesn't fall through and close Settings
underneath — same trap `panels.js` documents for its own panel/modal split.

**"Clear area" clears the shape and stays open** (used to behave as a
second Cancel) and resets the shape selector to circle. Saving with
nothing drawn is still how an area gets removed from an entry.

A self-intersecting polygon is allowed (server's even-odd ray casting gives
a defined answer). Switching shapes *clears* the current one — no
meaningful common size to convert between.

A `try/catch` around the `Map` constructor closes the editor cleanly if
WebGL is unavailable (also means the editor can't be inspected in a
WebGL-less sandbox at all — it closes itself on open; verify via the
route-intercept FakeMap/FakeMarker stub technique instead).

**Delivery**: ntfy.sh, **JSON publish API** (POST to `https://ntfy.sh/`
with `{topic, title, message, priority, tags}`) — not the header-based API,
which breaks on non-ASCII. `priority` must be a **number 1–5**.

**Message content** (`aircraftLabel`): flight/hex, registration, type code,
altitude (or "ground"), speed, each omitted when unavailable. Title carries
the reason (squawk code/meaning, "First time seen", "Watched aircraft") —
message body doesn't repeat it.

**Click-to-open**: ntfy's `click` URL, auto-detected once at startup via
`os.networkInterfaces()` (first non-internal IPv4) — must be a LAN address
reachable from the phone, never `localhost`. Best-effort by design.

**ntfy topic**: 8-char random string, auto-generated, persisted, regenerable.
Charset excludes `0/o` and `1/l/i` (a real user mistyped a code with one) —
don't add them back. Never log/hardcode a real topic anywhere persistent.

Web Push is deferred for good (needs a secure context, awkward over plain
HTTP on a LAN). A general radius-from-home geofence (independent of the
watch list) is deferred — see `TODO.md`.

**Known rough edge**: on a fresh install (empty `seen_aircraft`), every
aircraft currently in range fires a "first seen" notification. Not fixed —
mention it if the user is surprised by a notification burst after setup.

## Smart home / MQTT integration

A **third**, independent notification channel alongside ntfy: ntfy wants
human-readable title/message for a push notification, this wants
machine-readable JSON for a home-automation rule engine. Wired to three of
`rules.js`'s four notification rules — first-seen, watch-list, and squawk
7500/7600/7700 (added later, same cooldown-gated block as the ntfy squawk
notification, payload adds `squawk`/`squawkMeaning`). Range records remain
deliberately out of scope (a single pre-aggregated number, not a discrete
per-aircraft occurrence).

**Hand-rolled MQTT client (`server/src/notifications/mqtt-client.js`), not
the `mqtt` npm package** — deliberated with the user first. MLPR only ever
needs **publish, QoS 0, fire-and-forget** (losing one event to a briefly
unreachable broker is acceptable, same trade-off as ntfy) — no packet-ID
tracking, no ack/retry state machine, no subscribe path. ~250 lines over
Node's `net`/`tls` (so `mqtts://` is free). Verified via
`mqtt-client.test.js` (packet encoding against known spec byte sequences)
plus an in-process fake TCP broker with an independently-written decoder.
**Not** implemented, because nothing here needs it: QoS 1/2, subscribing,
MQTT 5, WebSocket transport.

**`connectTimeoutMs`** (default 10s): guards the whole path to a
successful CONNACK, cleared only on CONNACK (not the TCP `'connect'`
event) — a broker that completes the TCP handshake but never answers MQTT
CONNECT is just as real a failure. A plain one-shot `setTimeout`, not
`socket.setTimeout()` (which would misfire on a healthy but quiet session).

**`server/src/notifications/smart-home.js`** sits between `rules.js` and
the raw client: owns the persistent `MqttClient` singleton,
`reconfigureSmartHome()` (idempotent — a no-op PUT doesn't reconnect),
`publishSmartHomeEvent(...)`, `testSmartHomeConnection()` (opens a
**separate**, temporary connection using the current form values, so
credentials can be verified before saving).

**Availability**: Last Will (`<prefix>/status` = `offline`, retained) set
at CONNECT, delivered by the broker on unclean disconnect; `online`
published proactively on success. Graceful shutdown publishes `offline`
itself.

**Payload**: flat JSON, one topic per reason (`<prefix>/events/first_seen`,
`/watchlist`, `/squawk`) rather than one shared topic with a `reason`
field. Fields: `reason`, `timestamp`, `hex`, `flight`, `registration`,
`typeCode`, `altitude` (ground = `0`), `onGround`, `speed`, `lat`/`lon`
(`null` if unavailable); watch-list adds `matchedType`/`matchedValue`.
Never retained — a discrete occurrence, not persistent state.

**Settings**: a "Configure smart home" subview inside Notifications,
behind `requireSettingsAuth` **like the Server tab**, unlike the rest of
that tab — broker credentials are treated as a real infrastructure secret,
same tier as the Settings password/home location/server port. Stored
server-side (`smartHomeSettings` config key). PUT calls
`reconfigureSmartHome()` immediately.

**`/dev/smart-home-test`**: a form to fire a real event through the
**actual configured connection** without waiting for a genuine
first-seen/watch-list match, so HA automations can be iterated on quickly.
Distinct from Settings' own "Test connection" (temporary socket only).
`POST /api/notifications/smart-home/send-test-event` returns `{sent,
enabled, connected}`. **Available in production, like `/dev/icon_verify`**
— a dev machine has no real broker/HA to test against.

## Advanced statistics (Stage 7)

The Stats view (`public/js/stats.js`) has six charts plus a lazily-loaded
registrations table, re-fetched against a shared range selector (24h / 7d /
31d / 1y / all, default **all**). Range persisted directly to
`localStorage` (`mlpr-stats-range`), not through `settings-state.js` — it's
remembered UI state, not a Settings option. Every chart shows a
`loadingStats` placeholder the instant a refetch kicks off, before any
`await` — otherwise a slow `all`-range request reads as indistinguishable
from "no data yet". `server/src/stats-query.js`'s
`getStatsHistoryForRange` picks source per range: 24h reads in-memory
`history` (minute-level), everything else reads `daily_stats`.

**Bucket granularity is chosen from how much data the range actually
covers, never from the range's name** (`time-buckets.js`'s
`granularityForRange`, resolved once per request by `stats-query.js`'s
`granularityFor`, which feeds it the earliest `daily_stats` date):
24h → hourly; otherwise span ≤70 days → daily, ≤400 days → weekly (ISO
8601), beyond that → monthly. Span is the shorter of the range window and
the install's own age, so a two-day-old install's `1y`/`all` view reads
like the 7d one instead of collapsing into one monthly bar (a live
complaint — a single bar/dot is what "all time" showed for the first
month). Outside 24h it never goes finer than daily: `daily_stats` has one
row per day, and mixed granularities across the Stats screen's charts
would be worse than a coarse one. **Every time-bucketed endpoint resolves
granularity through `granularityFor`** (history, new-registrations,
registrations-trend) so no two charts on one screen can disagree about
what a bucket means.

**Every time boundary in the stats layer is local, never UTC**
(`time-buckets.js`'s `localDayString`/`startOfLocalDayMs`, used by
`bucketKey` and by `stats-history.js`'s day rollover): bucket keys,
`daily_stats` date keys, "Ten dzień", and the accumulator's midnight all
come through that one pair. UTC boundaries meant a UTC+2 receiver rolled
"today" over at 02:00 local and drew hour labels two hours behind the wall
clock. **Never reintroduce `toISOString().slice(...)` here** — that is UTC
by definition, and it is what this replaced. Consequences to keep in mind:
`chart.js`'s `formatBucketLabel` is a plain reformat and must *not* convert
timezones (the keys are already local — converting would double-shift);
`stats-query.js` turns a `daily_stats` date back into a timestamp with
`startOfLocalDayMs`, because `new Date('2026-08-04')` parses as UTC
midnight and lands on the previous day west of Greenwich; `isoWeekKey` is
seeded from local calendar fields (its internal `Date.UTC` normalization
only exists to make the day arithmetic DST-free). Rows written before
v2.1.9 are keyed by UTC day — the same string, just covering shifted
hours, so no migration was needed and only the changeover day has a seam.
Tests pin `process.env.TZ = 'Europe/Warsaw'` so a regression to UTC can't
pass unnoticed on a UTC dev machine.

### Registrations table (`public/js/stats.js`'s `loadRegistrationsTable`)

**Searched, sorted and paged server-side** (`server/src/stats-table.js`'s
`queryTable`, shared with the all-airlines table): `GET
/api/stats/registrations?search&sort&dir&page&pageSize` answers `{rows,
total, page, pageSize, totalPages, sort, dir}`. It used to return every
registration ever seen and let the browser do all three — measured at 88 KB
for 650 rows two days into an install, growing with every airframe ever
seen, so the pagination control was real while the paging wasn't. At 5,000
registrations a page is ~2.8 KB against ~669 KB for the whole table.
Load-bearing details:
- **Airline columns search and sort on the resolved *name*, not the ICAO
  code** — that's what the column displays. (The old client-side sort used
  the raw code, so the name column came out in no visible order.) The
  server resolves names via `airlines-data.js`; the client still fetches
  `/api/airlines` because only it can render locale-formatted rows.
- **`pageSize=0` means "every matching row"** and exists for exactly one
  caller: the CSV export, which downloads the current search/sort view in
  full. A rare explicit click, not the default path. Everything else is
  clamped to `MAX_PAGE_SIZE`.
- **Missing values sort last in both directions** (same convention
  `list.js` uses), and an unknown `sort` key falls back to the spec's
  default rather than erroring — a query string is a view preference, not a
  command.
- Client-side, every interaction is now a request, so `draw()` tracks a
  request id and only the newest response is allowed to paint. Defaults to
  `timesSeen` descending ("what shows up a lot" is more useful than "most
  recent" for a spotter), mirrored by the server's own `defaultSort`.
- The search box still lives outside the rebuilt subtree so typing doesn't
  lose focus, and is still debounced.
- `getRegistrationsList()` (every row, unpaged) survives for tests and
  in-process callers — **no HTTP route may return it wholesale**, which is
  the thing this replaced.

**CSV export** (`public/js/csv.js`'s `rowsToCsv`): exports the current
search-filtered, sorted view (every matching row, not just the current
page), tracked via closure variable `currentSorted` so export doesn't redo
the work. Each column's `value()` mirrors exactly what's shown on screen
(resolved airline name, locale-formatted dates). `rowsToCsv` is pure/DOM-
free, testable under plain `node --test`, quotes a field only when needed.

### Range/position sampling (`server/src/stats-history.js`, `range.js`)

`daily_stats` gained `avg_aircraft`, `avg_with_pos`/`max_with_pos`,
`avg_without_pos`/`max_without_pos`, `range_top_avg_km` alongside existing
`max_aircraft`/`total_messages`/`max_range_km`.

`range_top_avg_km` is a **deliberate, narrow exception** to "readsb already
computes max range, don't reimplement distance math" — `stats.json` only
exposes a single running maximum, never a distribution. `server/src/
range.js`'s pure Haversine `distanceKm()` runs once per poll tick per
aircraft-with-position against the effective home location, keeping only
the best distance *per minute* in memory (~1440 floats/day — an ephemeral
rolling aggregate, not "raw position history" under hard rule 4). At day
rollover this reduces to `max_range_km` (from `getRangeSummary()`, this
same self-computed figure, **not** readsb's `total.max_distance`) and
`range_top_avg_km` — the **mean of the top `ceil(n × 10%)`** per-minute best
samples (a mean-of-top-N, not a percentile cutoff — briefly implemented
wrong as a percentile before being caught and renamed). `getRangeSummary()`
always includes the current in-progress minute (never more than ~60s
stale).

**Aircraft counts have exactly one source per surface, and it is never
readsb.** The Stats *history* charts (`avgAircraft`, `maxAircraft`,
with/without position) are built from MLPR's own tracked set: `index.js`
counts it on every aircraft poll tick and pushes it into
`stats-history.js`'s `recordTrackedCounts`, which `ingestStats` then pairs
with readsb's message count. The live "Aktualnie" tiles and the List
panel's own total both count the *browser's* live set (`radar-state.js`'s
`liveAircraft`) — the same one the map draws. Before this there were three
answers on screen at once: readsb's counters in the charts, the server's
`getTrackedAircraft().length` sent over the WebSocket for the Stats tile,
and the browser's own set for the List. The server no longer sends an
aircraft count at all. `ingestStats` returns `null` until the first
`recordTrackedCounts` arrives rather than falling back to readsb's numbers
— a fallback would silently reintroduce the mismatch.

**`stats-history.js`'s two in-memory series (`history`, `rangeSamples`) are
rolling 24h+1h windows, pruned by age; nothing there is day-scoped except
`dailyAccumulator`.** Both used to be effectively day-scoped by accident —
range samples were cleared by `resetDailyAccumulator` at UTC midnight, and
`history` was capped at a flat 1440 entries — so the "last 24h" charts
really showed "since 00:00 UTC" (and only ~6h of that, see the `last1min`
sliding-window note above). Consequences to preserve: `getRangeSummary()`
now filters the rolling window down to `dailyAccumulator.date`'s day (keyed
off the accumulator's own date, not `now`, so a flush landing between
midnight and the next rollover call still summarizes the day it is writing);
`getMaxRangeLastHourKm` reads the rolling window and so is a true hour
across midnight too; pruning measures the window from the newest sample's
own timestamp, not `Date.now()`, because `history` is on readsb's clock.

**MLAT is excluded from this sampling entirely** (`isRangeEligible
(sourceType)`, true only for `sourceType` starting with `adsb_`) — an MLAT
position is triangulated from several receivers, so a "contact" can be
hundreds of km away for reasons unrelated to this antenna's own reach; this
would skew `range_top_avg_km` and the antenna coverage stats routinely, not
just as an outlier.

**The all-time-max-range notification/tile also reads from this same
self-computed, MLAT-excluded figure**, not readsb's `stats.json`
`total.max_distance` — `evaluateRangeRecordRule(bestRangeKm)` is called
right alongside `recordRangeSample(bestRangeKm)` in
`recordRangeAndRegistrationSightings`, so the daily figure and the all-time
record share one source of truth (previously two independently-filtered
mechanisms could disagree — a live inversion where "today" briefly showed a
higher max range than "all time"). readsb's own `total.max_distance` is **no longer read at all**. It used to
be ingested by `ingestStats()`, stored on every history sample and in the
daily accumulator, and broadcast to every browser in the `stats` WebSocket
message as `maxRangeKm` — with nothing displaying it. Calling that
"harmless, vestigial" was the wrong conclusion: it left an unfiltered,
MLAT-inclusive, receiver-restart-resettable number sitting one property
away from our own MLAT-excluded figures, which is exactly the pairing that
produced the live "today > all time" inversion. Removed end to end
(sample, accumulator, `getLatestStatsValues`, the WS payload,
`radar-state.js`'s `liveStats`), with a regression test asserting the key
is absent rather than merely unread.

### Registration visit-tracking (`server/src/stats-registrations.js`)

Separate from `seen_aircraft` (hex-keyed, first-seen notifications) — this
is registration-keyed, tracks *visits*. In-memory `Map`, lazy-load-then-
periodic-flush shape like `trail-history.js`. `recordSighting(registration,
{typeCode, airlineIcao}, now)` called every poll tick for every currently-
tracked aircraft with a registration (not just this tick's delta).
**15-minute visit-gap rule**: gap `>= 15 min` since `lastSeenAt` increments
`timesSeen` (a new visit); otherwise only `lastSeenAt` advances.
`typeCode`/`airlineIcao` update when a later sighting provides them, never
cleared by one that lacks them. Flushed to `registrations` table
(`registration` PK, `type_code`, `airline_icao`, `first_seen_at`,
`last_seen_at`, `times_seen`) on the existing 45s flush tick.

"Most popular type/airline" and "new registrations" derive from this one
table by filtering on `lastSeenAt`/`firstSeenAt` against the range cutoff.
"Most popular" counts **distinct registrations**, not raw sighting
frequency.

### Airline identification (`server/src/airline-lookup.js`)

`identifyOperator(aircraft, airlines)`: `dbFlags` bit 1 (military) → no
airline; callsign (trimmed, uppercased) equal to registration with dashes
stripped → private/GA, no airline; else matched against
`^([A-Z]{3})([0-9][0-9A-Z]{0,3})$` (3-letter ICAO prefix, digit
immediately after — naturally excludes tactical military callsigns like
"DUKE21") and looked up in the loaded airline map. Data source: OpenFlights'
`airlines.dat` — **ODbL-licensed data only, never their AGPL code** —
fetched by `scripts/fetch-airlines.mjs` (hand-written CSV parser, no
dependency) into `data/airlines.json` (`{icao: {name, country}}`, filtered
to active airlines with a non-empty ICAO code), best-effort, never
committed. Served via `GET /api/airlines`
(`server/src/airlines-data.js`, loaded once at startup, empty-Map fallback
if the file doesn't exist yet). **Never commit airline logos** — trademark
risk, and unneeded since doughnut charts use plain color swatches.
**Unmatched 3-letter prefixes are logged**: `logUnmatchedPrefixOnce`
(`kind: 'airline_unknown'`), deduped per-prefix by a module-level `Set` —
only the first occurrence per process lifetime gets a `console.warn`
(plain, not a pino logger — this module is a pure classifier several
layers from Fastify).

### Chart rendering (`public/js/chart.js`)

Extends the existing hand-rolled `renderSparklineSvg` pattern — no
charting library (every shape here is a well-known SVG technique). All
renderers are pure string-building functions, zero DOM dependency,
testable under plain `node --test`: `renderLineChartSvg` (multi-series +
max label), `renderAreaChartSvg` (stacked), `renderBarChartSvg` (grouped),
`renderDoughnutSvg`/`doughnutSlices` (stroke-dasharray, slices beyond
`maxSlices` folded into "Other").
**Single-bucket edge case**: a `<polyline>`/`<polygon>` needs ≥2 points, so
with exactly one bucket `renderLineChartSvg` draws a `<circle>` and
`renderAreaChartSvg` draws `<rect>` bars instead — regression tests cover
both.

**Hover tooltip**: every bucketed chart (line/area/bar) gets an invisible
full-height `<rect class="mlpr-chart-hit" data-i="N">` per bucket, tiled
edge-to-edge (Voronoi-style — hovering near a point, not just exactly on
it, resolves to it). Line/area get a per-bucket vertical guide plus one
`<circle class="mlpr-chart-point" data-i="N">` per bucket per series (area's
sits at the top of its own stacked slice). Bar charts skip the guide/points
and instead brighten the whole bar group on hover (`.mlpr-chart-bar`,
`filter: brightness(1.4)`); their hit region is the whole group column, not
just the bar.
All DOM/pointer logic lives in `stats.js`'s `wireChartTooltip`, called
after every `innerHTML = renderXChartSvg(...)`. It **never recomputes**
which bucket a screen position belongs to — it only reads the `data-i`
attribute the renderer itself wrote (`event.target.closest
('.mlpr-chart-hit')`), same "hit-test and drawing share one source of
truth" reasoning as the trigger-area rectangle bounds. `pointerdown` is
wired alongside `pointermove` for touch, which has no hover state.
`series` arrays gained a `label` field purely for tooltip row text — the
separately-built legend HTML is untouched. Tooltip reuses whatever
`formatValue`/`formatBucket` the chart itself used. Positioned from the
real event's `clientX`/`clientY` relative to the wrapper's
`getBoundingClientRect()` (not the SVG's internal viewBox space), clamped
to stay inside the wrapper.

### Stats v1.1: Now/Today/All-time sections, antenna stats, all-airlines

Three new top sections in `stats.js`, ahead of the range-selected charts:

- **"Aktualnie" (Now)** replaced the old 3-item tile row entirely (no
  double-display of aircraft count/messages-per-sec on one screen).
  Aircraft count, with-position count, messages/sec, rolling last-hour max
  range — all live client-side (`radar-state.js`'s `getLiveStats`/
  `getLiveAircraft`). Nearest/farthest tiles computed **entirely
  client-side** (`public/js/geo.js`'s `findNearestFarthest` — `distanceKm`/
  `bearingDegrees` duplicated from `server/src/range.js`, ~10 lines,
  simpler than inventing a shared-code mechanism between `server/src` and
  `public/js`). Home location for this is **not** read from `app.js`'s
  existing `homeLocation` — `stats.js` does its own `fetch('/api/settings')`
  on panel open (same endpoint/access-control as the home marker), kept
  isolated to avoid touching hard-to-verify map code for an unrelated
  feature.
- **"Ten dzień" (Today)** and **"Od początku" (All time)** hit one endpoint,
  `GET /api/stats/summary?period=today|all`, bundled server-side rather
  than 6+ separate per-chart requests. "Today" reads new live in-memory
  state; "All time" reads existing persistent tables.
  - **Unique aircraft/flights today**: new tracking — neither
    `seen_aircraft` nor `registrations` can answer "was this also seen
    today." `dailyAccumulator` grew `uniqueHexes`/`uniqueFlights` Sets, fed
    every poll tick from the existing per-tick "iterate every tracked
    aircraft" loop. Reset at the same UTC-midnight boundary
    `dailyAccumulator` already uses (`getTodayStartMs`). Sets spread to/from
    arrays for `snapshotForPersistence`/`restoreFromSnapshot` (same
    restart-survival mechanism, hard rule 6 exempts *today's* accumulated
    numbers).
  - **All-time unique aircraft/flights/registrations**: `seen_aircraft`/
    `registrations` needed only a `COUNT(*)`. Unique flights all-time
    needed a new table, `seen_flights` (`flight TEXT PRIMARY KEY,
    first_seen_at`), guarded the same way as `seen_aircraft`
    (`hasSeenFlight` SELECT before `markFlightSeen` INSERT — hard rule 5,
    getting this guard wrong was a real caught-before-ship bug).
  - **Max-range tile** (`/api/stats/summary`'s `maxRangeKm`): the all-time
    record via `getAllTimeMaxRangeKm` on the `all` range, a max over the
    range's buckets otherwise. This overlapped with a time-bucketed range
    bar chart that plotted the same figure over the same range; **the chart
    was dropped and the tile kept**, deliberately that way round — on the
    `all` range this tile is the only place the all-time record is visible
    anywhere in the UI, and it's the exact value the "new range record"
    notification fires on, whereas a chart of a record over time was the
    weaker of the two. Range readings now left on the screen: rolling last
    hour ("Now" tile), this range (this tile), per altitude band all-time
    (antenna section) — three, each showing something the others don't.
- **Doughnut ↔ line toggle** on "most common type/airline" charts
  (`chartView` state, two pill buttons). Line view is *new-registrations-
  of-this-type/airline over time* (reusing the existing "new registrations"
  bucketing, `getNewRegistrationsBucketsByKey`), split into one series per
  top-N key from the doughnut's own counts, restricted to
  `TREND_TOP_N` (5) — a long tail of one-off types would be pure noise.
  Endpoint: `GET /api/stats/registrations-trend?range&field=type|
  airline&keys=A,B,C`, never independently decides what's "top."
  **These two charts live in the range-summary subsection, next to its
  tiles — there is exactly one pair of them.** They were briefly drawn
  twice on the same screen: once here and once, without the toggle, from
  `/api/stats/summary`'s own `topTypes`/`topAirlines`. Same range, same
  server-side function (`getTypeCounts`), same label — identical numbers
  under an identical heading. The summary endpoint no longer returns those
  fields at all (they were also several KB of untruncated JSON per refresh,
  every 20s, for a chart already fetching its own copy). If a "breakdown of
  this range" is ever wanted somewhere else on the page, move this pair —
  don't add a second one.
- **Antenna statistics** (`server/src/antenna-stats.js`, all-time-only,
  never range-selected or daily-reset — it carries a `.mlpr-scope-note`
  saying so, since it sits below the range selector and would otherwise
  read as if the selector applied to it): a range-by-altitude bar chart (9
  fixed bands, 0–5k ft up to 40k+, ground = 0 ft) and a directional
  coverage rose chart (`renderRoseChartSvg`, 180-sector compass rose).
  Persisted as one JSON blob (`antennaStats` config key), **only when
  actually dirty** (`flushAntennaStatsIfDirty`), on its own
  `ANTENNA_STATS_FLUSH_INTERVAL_MS` (5 min) interval — **not** the 45s
  daily-stats flush it used to share. This is the largest thing the app
  writes to the SD card: a full rewrite of every cell, and "only when
  dirty" bounds nothing while a receiver is still filling in coverage,
  because nearly every tick brings a new best somewhere. Measured live at
  108 KB before this, i.e. ~200 MB/day; every distance is now stored via
  `range.js`'s `roundKm` (10 m — 91% of that blob was float digits on a
  figure drawn as "434 km"), which took it to ~39 KB and also damps the
  dirty flag, since a sample that rounds to a value already held is no
  longer an improvement worth a write. `roundKm` lives in `range.js` (the
  distance module) and is applied at every point a distance is *stored*:
  antenna cells, per-minute range samples, and `index.js`'s `bestRangeKm`
  — that last one rounded **once**, before both `recordRangeSample` and
  `evaluateRangeRecordRule`, so the daily figure and the all-time record
  keep sharing one exact number. Bearing math (`bearingDegrees`) added to
  `range.js` alongside `distanceKm`.

  **Every cell's top-K is deduped by aircraft (`hex`), and gated by decode
  volume.** Per-second polling used to offer the same aircraft to a cell
  over and over while it sat in one sector at one altitude, so the retained
  "best 5" were usually 5 consecutive seconds of one plane — measured live,
  `topAvgRangeKm` equalled `maxRangeKm` in 169 of 180 sectors, i.e. no
  outlier resistance at all. `insertIntoTopK` now keeps at most one entry
  per `hex` per cell (a same-hex sample only updates in place, and only if
  it improves on that aircraft's own best), so a cell's top-5 are the best
  five *distinct* aircraft ever recorded there. `mergeTopK` (used when
  combining several cells — every sector for one band, or every band for
  one sector) dedupes across the whole merge too, not just within each
  source cell, since one climbing/descending aircraft can be its own
  best-ever contact in more than one of the cells being combined.
  `recordAntennaSample` additionally requires `isAntennaSampleEligible`
  (`messages >= MIN_MESSAGES_FOR_SAMPLE`, 4) before a sample is even
  offered to a cell — `messages` is readsb's own cumulative per-aircraft
  decode counter (the details panel's "Messages received" tile), read
  directly off decode volume rather than elapsed polling time, so a single
  lucky decode from a distant aircraft (a bit-error near-miss, or a contact
  glimpsed for a couple of frames before fading) can no longer set a
  "best-ever" figure on its own — the user's own suggestion, and the actual
  remaining piece of outlier resistance the hex-dedup above doesn't cover
  by itself (deduping only stops one aircraft's *repeated* samples from
  dominating; it does nothing about one aircraft's *single* fluke sample).
  4 is deliberately low — a global CPR position decode needs at least two
  position frames, so this asks for barely more than "seen more than
  once," not a sustained contact.

  **Persisted as compact `[km, hex]` tuples**, not `{km, hex}` objects —
  repeated JSON field names were most of the weight of a similar blob
  elsewhere in this app (`stats-history.js`'s snapshot; see that section),
  and at up to `BAND_SLOTS * SECTOR_COUNT * TOP_K` = 9,000 entries here the
  same waste would apply. `ensureLoaded`'s shape check now verifies every
  entry, not just the outer band/sector shape — a blob from before this fix
  has the same outer shape but plain-number leaves, which would otherwise
  pass the check and then be misread as tuples. As with the redesign before
  this one, a shape that doesn't match is ignored and started fresh rather
  than migrated — there's no way to recover which aircraft contributed each
  historical number.

  **Everything here is relative to the home location it was recorded
  against**, so moving the receiver invalidates all of it at once and
  nothing else would ever correct it. `POST /api/stats/antenna/reset`
  (`requireSettingsAuth`, Settings → Server, next to the receiver location)
  clears the coverage cells (`clearAntennaStats` — deletes the config key,
  unlike `resetAntennaStats`, which only drops the in-memory copy and would
  reload the same blob on the next read), the all-time range record
  (`resetAllTimeMaxRangeKm` — otherwise a record set from the old position
  can never be beaten from the new one and its notification goes
  permanently silent), and the rolling per-minute range samples
  (`clearRangeSamples`). It deliberately does **not** touch `daily_stats`:
  those rows are a historical log of what was true on each day, not a
  current claim about where the antenna reaches.

  **`PUT /api/settings` reports, it does not act**: it answers with
  `homeMovedKm` (distance between the old and new *effective* home, so
  dropping a manual override counts too, since it falls back to
  receiver.json's position) and the Server tab shows a notice above the
  clear button past `HOME_MOVED_NOTICE_KM` (1 km). Wiping months of
  coverage as a side effect of correcting a coordinate would be a nasty
  surprise, and a sector is 2° wide — ~10 km of arc at long range — so
  nudging the pin by a few hundred metres changes nothing meaningful and
  must not nag.

  Per (altitude band, sector) cell, retains the **best `TOP_K` (5) samples
  ever** (`insertIntoTopK`, sorted-and-capped, still bounded regardless of
  runtime — hard rule 4 still holds), not just a single running max. Two
  figures per cell: `maxRangeKm` (single best-ever, the honest "record")
  and `topAvgRangeKm` (mean of the retained best 5 — outlier-resistant,
  since a single MLAT glitch is diluted against 4 realistic samples). The
  rose chart and bar chart show `topAvgRangeKm` (bar chart shows both as
  two series) — this fixes the "jagged starburst" look a single running
  max produces (VRS/tar1090's own visualizations have this problem).

  **Sector count: 180 (2° each)**. Tradeoff: too coarse and a sector
  "speaks for" a wide swath of geography at long range (arc length is
  r·θ); too fine and most sectors rarely accumulate enough real contacts
  for a top-5 figure to mean anything. Storage/CPU cost is **not** the
  limiting factor at any resolution considered (72–360) — this is purely a
  statistical-sparsity tradeoff, self-correcting as data accumulates over
  months. `UNKNOWN_BAND_SLOT` (internal-only) preserves directional
  information for Mode-S-only contacts with no altitude — merged into the
  "all altitudes" view but never shown as its own named band.

  A stored config blob from before this redesign is detected (shape check
  in `ensureLoaded`) and ignored rather than crashing — starts fresh.

  **Signal strength** (mean/peak dBFS): a separate, simpler live-only
  reading from `stats.json`'s `last1min.local.signal`/`peak_signal`,
  ingested every ~15s, **not averaged or persisted**. `null` (not zero) for
  a `--net-only` readsb with no local SDR — shown as "not available," never
  a misleading `0 dBFS`.
- **All airlines table**: mirrors the registrations table, lazy-loaded,
  server-side sort/search/paginate through the same `queryTable`. `db.js`'s
  `getAllAirlinesSummary` is a `GROUP BY airline_icao` off the existing
  `registrations` table. Its result is bounded by how many airlines exist
  (a few hundred), not by airframes seen, so paging it was never about
  payload size — it's there so both tables share one client code path
  (`loadLazyTable`). Cost to be aware of: that `GROUP BY` now re-runs on
  every page/sort click rather than once per table open.

### Reception coverage map layer (Settings → Map, off by default)

A real shape on the map itself (not just the Stats rose chart) showing
reception range per direction — fed by the antenna-stats redesign above.
Two polygons over one shared GeoJSON source/two layers
(`ensureCoverageLayer`, same "one source, two layers filtered by a
property" shape as the trail/trail-gap split, forced by the same
constraint):

- **Fill** (`mlpr-coverage-fill`): the outlier-resistant `topAvgRangeKm`
  boundary, semi-transparent — the primary shape.
- **Outline** (`mlpr-coverage-outline`): the honest `maxRangeKm` boundary,
  thin dashed line only, no fill — kept as a second visually-distinct layer
  so the record contact stays visible without dominating the whole shape.

**Server** (`GET /api/stats/antenna/coverage?band=all|0..8`): calls
`getSectorStats(bandIndex)` at full 180-point resolution, then a new
`destinationPoint(lat, lon, bearingDeg, distanceKm)` in `range.js` (inverse
of `distanceKm`/`bearingDegrees`, round-trip verified in `range.test.js`)
turns each (bearing, range) into a real lat/lon. **Gated by
`requireSettingsAuth`, same as `/api/settings`** — every vertex is `home ±
bearing ± distance`, exactly as revealing of the receiver's location as the
home marker.

**A sector with nothing recorded resolves to distance 0** (`coverageRing`)
— the polygon pinches to the home coordinate there. This has been tried
both ways; the current state (as of v2.1.12) is back to distance-0, and
the reasoning for *why* matters more than the current setting, since it's
liable to be revisited again as data accumulates:

- **Visually**, distance-0 drags the boundary back to the receiver and out
  again for every unsampled sector, which on a sparse install (reported
  live right after v2.1.10 reset the stored coverage: 113 of 180 sectors
  empty) reads as a spiky "sea urchin."
- **A v2.1.11 fix skipped empty sectors instead**, joining each pair of
  real neighbours with a straight chord across the gap — calmer-looking,
  same underlying data. **Reverted the same day**, after checking the
  actual enclosed area with the shoelace formula rather than trusting how
  it looked: a spike-and-return (distance 0) degenerates to *exactly* 0
  km² of enclosed area across any gap, however wide, because it enters and
  leaves the same point — genuinely a "no data" shape, not just an ugly
  one. A chord between two real points across that same gap enclosed a
  real, measured ~3,245 km² for one representative 18° gap in a quick
  check — area that was never actually sampled, rendered as if it were.
  Trading a confirmed-zero-claim for a confirmed-nonzero-claim on
  unmeasured ground is a worse kind of wrong than looking spiky,
  especially on a sparsely-populated install, which is exactly when the
  chord version's fabricated area is largest (bigger gaps between whatever
  few real points exist).
- **Open question, not yet answered**: does the spiky look actually fade
  as sectors fill in over real days/weeks (the receiver's own hypothesis,
  2026-08-05), or does it stay visually rough at whatever level of
  sparsity a typical install settles at long-term? Re-evaluate against
  real accumulated data before changing this again — don't re-derive the
  chord-vs-spike area tradeoff from scratch, the math above already
  settled that part.

**Client**: `showCoverage` (default off) and `coverageBand` (`'all'`,
`'stacked'`, or an `ALTITUDE_BANDS` index) in `settings-state.js`. Color
from `trail.js`'s `colorForAltitude`, fed a representative midpoint
altitude per band (`COVERAGE_BAND_MIDPOINT_FT`); "all altitudes" gets a
fixed neutral green. Re-fetched when the settings change **and** on a
`COVERAGE_REFRESH_INTERVAL_MS` (2s, since 2026-08-05 — requested
specifically to watch the coverage map build up live as data accumulates,
was 15s) timer while on. Cached GeoJSON is reapplied by
`ensureCoverageLayer` whenever the style resets (`setStyle` wipes sources
on basemap switch).

**The 2s cadence is only safe because most ticks are cheap.**
`recordAntennaSample` bumps an in-memory `revision` counter
(`antenna-stats.js`) on every genuine change — a sample that actually
improved a cell, or a manual clear via `clearAntennaStats`. `GET
/api/stats/antenna/revision` (same auth gate as the coverage endpoint)
answers just that bare integer — no sector iteration, no
`destinationPoint` trig, nothing the coverage endpoint itself does.
`refreshCoverage(force)`: the periodic timer calls it with `force=false`,
which polls `/revision` first and returns immediately if it matches
`lastKnownCoverageRevision` — skipping the real coverage fetch **and** the
MapLibre `setData()` call that would otherwise re-upload the whole polygon
to the GPU every two seconds regardless of whether anything changed.
`force=true` (initial load, a tab regaining visibility, or the
`coverageBand`/`showCoverage` setting itself just changing) always does
the real fetch — a stale cached revision could still equal the current one
after a band switch, since revision tracks "did antenna data change,
period," not "for this specific band." Compared with `!==`, not `>`,
specifically so a server restart (revision resets to 0) still reads as
"different" and triggers a catch-up fetch, rather than the client's
higher cached number looking frozen at "up to date" forever. The
coverage endpoint's own response also carries `revision` (not just
`/revision`), so a `force=true` fetch updates the client's bookmark from
the exact data it just rendered, instead of racing a separate poll against
it.

**`'stacked'` is an explicitly experimental option** (labelled as such in
the dropdown), added 2026-08-05 to answer one question: is every altitude
band's shape layered on the map at once even legible, or does it just
become mud? Reasoning it's testing rather than shipping as a finished
feature: the polygon is a *historical* envelope (best-ever/best-recent
recorded contacts), not a live reception prediction, so a live aircraft
sitting outside every layer is expected, not a bug — reported live right
after the empty-sector-handling change above, and worth remembering if
this gets revisited. `GET /api/stats/antenna/coverage?band=stacked`
answers `{ bands: [{ band, fillPolygon }, ...] }` for all nine
`ALTITUDE_BANDS` in one request (`band` in ascending index order,
`fillPolygon` null only if no home is configured at all — a band with zero
recorded samples still gets a ring, degenerated to the home coordinate,
same as the non-stacked path) — its own response shape, no `maxPolygon`,
rather than the client looping the single-band request nine times, same
"one round trip, not a fan-out" discipline as everywhere else in this app.
`app.js`'s `stackedCoverageFeatures` sorts the response **descending by
band index** before building GeoJSON features — highest altitude (band 8,
the farthest-reaching, largest shape) first, so it paints as the back
layer, with each progressively lower/shorter-reaching band layered on top
of it. This is load-bearing, not cosmetic: GeoJSON feature order is render
order for one MapLibre fill layer, alpha-blended "draw over" compositing
is not order-independent, and the reverse order would let the biggest
shape paint over every smaller one last. Deliberately **fill-only, no
`max` outline features** — nine dashed outlines over nine overlapping
fills would fight the one thing this experiment exists to judge.

**A note on verifying anything in this section**: this sandbox has no
WebGL, and `new maplibregl.Map(...)` throws *synchronously* inside its
constructor when that happens — which halts the rest of `app.js`'s
top-level module evaluation, including every `onSettingsChange`/
`setInterval` below it. A real browser's console just shows the one WebGL
error and otherwise looks quiet, which reads exactly like "no errors, must
be fine" — but nothing past that point ever ran. Re-verifying anything in
`app.js` reacting to settings/timers needs the FakeMap/FakeMarker/FakePopup
stub technique (route-intercept `/vendor/maplibre-gl/maplibre-gl.js`,
serve a fake implementing just the methods `app.js` calls) so the module
actually finishes loading — a screenshot or "no new console errors" alone
will not catch a dead reactive path.

## Settings access control (`server/src/settings-auth.js`)

Off by default (local LAN app) — a button in Settings → Server opts in.
`node:crypto`'s `scryptSync` (random salt, no dependency), `timingSafeEqual`
for comparison. Sessions: random tokens on login, held **in memory only**
(`Map<token, expiresAt>`, 24h TTL, pruned hourly) — lost on restart,
consistent with hard rule 6.

**Brute-force lockout** (in-memory only, pruned hourly): per-IP, 5 failed
`verifyPassword()` calls within the lockout window lock that IP out for 5
minutes (`429`, checked *before* the password check, so a locked-out
client can't spend a guess waiting it out). Guards both
`/api/settings-auth/login` and `/api/settings-auth/password`'s own
`currentPassword` check.

**Gates the Server tab only, not the whole Settings panel** — a deliberate
narrowing (originally gated the entire panel before opening). Only
server-level controls need a gate: the password itself, the home location,
the listening port. `requireSettingsAuth` preHandler applied per-route to
`/api/settings*` and `/api/server/port*` — **not** `/api/notifications/*`,
`/api/settings-auth/*` itself, `/api/daylight`, or `/api/stats/history`.
No-op when no password is set.

Frontend: `renderSettingsForm` always renders all five tabs; only
`renderServerTab` checks `passwordSet && !getStoredToken()` and swaps in
the login form. `authedFetch` takes an explicit `onUnauthorized` callback
per call site, so a 401 only resets the Server tab's own content. Token
lives in `sessionStorage` (`settings-auth.js`), attached via
`X-MLPR-Settings-Token`.

Setting/changing/removing the password is **not** behind the token
preHandler — changing requires the *current* password (checked inside the
handler), independent of session validity.

## Production deployment (Stage 6)

`scripts/install.sh` + `systemd/mlpr@.service` — templated unit (`User=%i`,
`WorkingDirectory=/home/%i/My-Local-Plane-Radar`), instantiated as
`mlpr@<username>.service`. Install script detects too-old/missing Node and
**aborts with NodeSource instructions rather than auto-installing** (needs
the user's own sudo password). Runs `npm ci --omit=dev` (skips Playwright,
~300MB, dev-only), fetches the basemap if missing, installs/enables the
unit (needs sudo — expected, user-run script, not a web endpoint).

Also wires up readsb's `--db-file` if readsb is present and not already
configured: downloads wiedehopf/tar1090-db's `aircraft.csv.gz` to
`/usr/local/share/tar1090/`, appends `--db-file` to `JSON_OPTIONS`, restarts
readsb. Without this, `r`/`t`/`desc` are never present in `aircraft.json`
for any aircraft — silently breaks the details panel's registration/type
tiles and the dbFlags bits. Idempotent (greps for `--db-file` first),
best-effort (failed download warns and continues). Configures readsb via
its own documented `EnvironmentFile` mechanism — doesn't cross the GPL
boundary.

`index.js` handles `SIGTERM`/`SIGINT` (systemctl stop/restart, reboot):
flushes the in-memory daily-stats accumulator to SQLite before exiting, so
a routine restart doesn't lose up to 45s of that day's aggregate. Live
aircraft state staying RAM-only and dropping on restart (hard rule 6) is
still fine and unchanged.

**`closeWebSockets()` must be called before `await app.close()`**
(`server.js` returns it alongside `app`/`broadcast`) — an upgraded
WebSocket never ends on its own, so `app.close()` (which waits for every
connection to drain) would hang forever with any browser tab open, until
systemd's `TimeoutStopSec` (90s default) SIGKILLs it. Uses `ws.terminate()`,
not `ws.close()` (which starts a closing handshake an unresponsive client
may never answer) — the process is exiting anyway and `app.js`'s own
WebSocket close handler reconnects a second later. If a future change adds
another kind of long-lived connection, it needs the same treatment — watch
for a "shutting down" log line with the process still alive afterward.

### Stats history snapshot (`snapshotForPersistence`/`restoreFromSnapshot`
in `stats-history.js`)

The 24h charts read from `stats-history.js`'s in-memory `history` array and
range-sampling state — unlike `daily_stats`, these were **not** persisted
at all originally, so every restart reset them to empty. Worse, a
same-day restart also regressed `daily_stats` itself: `dailyAccumulator`
reset to zero, and the next flush upserted today's row with only the
since-restart numbers, discarding what had already accumulated.

Fix: `snapshotForPersistence()` captures `history`, the full
`dailyAccumulator`, `rangeSamples`, and in-progress-minute range state.
**`restoreFromSnapshot()` restores the two halves under deliberately
different guards**: the rolling 24h series (`history`, `rangeSamples`,
in-progress minute) come back from *any* snapshot and are then age-pruned
exactly as at runtime — they aren't day-scoped, so a snapshot written at
23:50 is precisely what a 00:10 restart should resume from; the day-scoped
`dailyAccumulator` is restored **only if the snapshot's date is today** (a
snapshot from yesterday — e.g. the Pi was off overnight — must never
overwrite today's fresh numbers; `rolloverIfNewDay` already handles a day
boundary crossed while running, this is the startup-restore equivalent).
The guard used to be all-or-nothing, which emptied the 24h charts on every
restart that happened to cross midnight. The restore path additionally
measures the window against the wall clock (`referenceMs`), so a snapshot
from last week is dropped however self-consistent its own timestamps are.
Reads a `todaysRangeSamples` key as a fallback — the pre-rolling-window
name, so an already-stored snapshot still restores after an upgrade.
Persisted
via `setConfigJSON`/`getConfigJSON` on its own **hourly**
(`STATS_HISTORY_SNAPSHOT_INTERVAL_MS`) interval — deliberately less
frequent than the 45s `daily_stats` flush, since this blob is far bigger
(up to 1440 samples) and repeated full-blob rewrites matter for SD wear.
Also written on the graceful-shutdown path. Restored once at startup,
before poll loops start.

## Documentation (`docs/`)

`docs/README.md` is the user-facing guide (GitHub renders it automatically),
a screen-by-screen tour, linked from the main `README.md`'s "Features"
section. `docs/images/` holds real screenshots taken against **synthetic
seeded data only** — never real receiver data or coordinates, same rule as
home-location. Separate from `CLAUDE.md` (architecture/decisions, for
future dev sessions) and `TODO.md` (deferred work) — `docs/` is purely for
end users.

## How we work

- Small, vertical slices — always something working end-to-end, never "all
  backend, then all frontend."
- Commit often, in small pieces, with meaningful messages. Git is the undo
  mechanism.
- Tests for the rule engine and JSON parsing are mandatory (`fixtures/` +
  built-in `node:test`). Everything else is optional.
- Code and comments in English (project is public). Conversation happens in
  Polish.
- Raspberry Pi-specific things (systemd units, `/run/readsb` permissions,
  ARM dependencies) get verified by the user on real hardware. If something
  isn't certain, say so instead of guessing.
- When in doubt about a requirement — ask, don't assume.
- Whenever the user says something is deferred ("we'll do that later",
  "improve it later"), add it to `TODO.md` immediately rather than letting
  it evaporate.
- **Nothing leaves this machine without the user's explicit go-ahead.**
  Committing locally is fine unprompted; `git push`, pushing a tag, and
  `gh release create` are not. Propose it ("gotowe do wypchnięcia?") and
  wait. This reversed an earlier push-immediately default — the point is
  that the repo and its releases are public, so every push is a
  publication.
- **Every version bump gets a git tag and a GitHub release, not just a
  `package.json` commit.** `git tag -a vX.Y.Z -m vX.Y.Z && git push origin
  vX.Y.Z`, then `gh release create vX.Y.Z --title "..." --notes "..."` —
  both after approval, per the rule above. Missed once (v2.1.6 shipped a
  commit and a push but no tag/release until asked) — check this is
  actually done, not just intended, whenever a version bump happens.
- **Release notes are English, always** — GitHub is English-only, no
  exception. v2.1.8 and v2.1.9 were briefly published in Polish and have
  since been corrected; if either is ever seen in Polish again (e.g. a
  stale cache), re-edit it, don't treat it as the pattern. Real prose
  grouped by feature/theme, not a bare commit list: a short "Patch release
  on top of vX.Y.(Z-1)" line, then a `##` heading per notable change with a
  plain-language explanation. Conversation with the user still happens in
  Polish per the project-wide rule above — this bullet is about the GitHub
  release text specifically.
- **Never put real receiver data in a release note, a commit message, or
  anything else public**: no coordinates or home location (the existing
  hardcoding ban), and no real figures read off this install — measured
  ranges, sector/coverage numbers, aircraft counts, registrations,
  callsigns, ntfy topics. Describing *what* changed is fine; quoting what
  this antenna actually saw is not. Live readings are for the
  conversation and for `CLAUDE.local.md`, which is gitignored.
