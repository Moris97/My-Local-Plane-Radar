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
  - **Map theme** (`mapTheme`, also in `settings-state.js`, default `dark`):
    independent of `basemapMode` — dark/light applies to *both* online and
    offline modes, four combinations total. This is a **map-only** theme, not
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
  background, hover/press feedback): List (sortable, clickable, click
  centers map), Stats, Settings (theme, units, altitude filter, layer
  visibility). Deliberately compact/centered, not stretched across the bar.
- List and Settings are bottom sheets on phones, a side panel on large
  screens; closable via X or Android/iOS back-gesture. Map stays visible on
  desktop. **Stats is a full-screen view instead** (`#fullscreen-modal` in
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
- **Dark theme is the default** — this is a radar display, must be readable
  at night without glare. Color theme: green, blue, black.
- Plane icon rotates to heading. Click shows trail + basic info with a "show
  more details" button that opens the full aircraft details panel (see
  below) — reuses the same bottom-sheet/side-panel mechanism as List/Settings
  (`public/js/panels.js`'s `PANELS.aircraft`), just not tied to a bottom-bar
  button — opened contextually via `openPanel('aircraft')` after
  `setInspectedHex(hex)` (`radar-state.js`).

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
- Type + callsign label appears at appropriate zoom levels.
- **Trails are opt-in per Settings → Map**: `trailsEnabled` (on/off) +
  `trailMode` (`click` — only the selected aircraft, default; `all` — every
  aircraft's trail drawn simultaneously, colors included). The grey
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
- Settings panel is organized into four tabs: General (units, password
  protection), Map (basemap layer, trails, home location), Aircraft (altitude
  filter, watch list), Notifications.

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
above the charts. `server/src/stats-query.js`'s `getStatsHistoryForRange`
picks the source and bucket granularity per range: 24h reads the existing
in-memory `history` array (minute-level already) plus today's in-progress
range samples; everything else reads `daily_stats` rows. Bucket granularity
(`server/src/time-buckets.js`): 24h → hourly, 7d/31d → daily, 1y → weekly
(ISO 8601 week numbering — a week belongs to whichever year owns its
Thursday, so e.g. 2025-12-29 buckets into `2026-W01`), all → monthly. This
keeps every chart at roughly 12–60 points regardless of how long the install
has been running, rather than one point per day forever.

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

Off by default (local LAN app, most people don't need this) — a button at the
bottom of Settings ("secure settings access with a password") opts in.
`node:crypto`'s `scryptSync` for password hashing (random salt per password,
no new dependency), `timingSafeEqual` for comparison. Sessions are random
tokens issued on login, held **in memory only** (`Map<token, expiresAt>`,
24h TTL, pruned hourly) — lost on restart, which just means logging in again,
consistent with hard rule 6.

Protected via a `requireSettingsAuth` Fastify `preHandler` applied per-route
to `/api/settings*` and `/api/notifications/*` — **not** applied to
`/api/settings-auth/*` itself (login/status/password-management need to work
*without* being logged in yet) or to `/api/stats/history` (general app data,
not a setting). The preHandler is a no-op whenever no password is set, so the
default-open behavior is unchanged until someone opts in. Frontend
(`public/js/settings-auth.js`) holds the token in `sessionStorage` and
attaches it via the `X-MLPR-Settings-Token` header; a 401 anywhere clears the
stored token and re-renders the login gate rather than failing silently.

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

`index.js` handles `SIGTERM`/`SIGINT` (what `systemctl stop`/`restart` send):
flushes the in-memory daily-stats accumulator to SQLite before exiting, so a
routine restart doesn't lose up to 45s of that day's aggregate. This is the
one piece of "current state" worth saving on shutdown — live aircraft state
staying RAM-only and getting dropped on restart (hard rule 6) is still fine
and unchanged.

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
