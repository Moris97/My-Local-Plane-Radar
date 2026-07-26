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
optional**, many are frequently absent:

- `hex` — 24-bit ICAO address, our primary key
- `flight` — callsign, has trailing spaces, must be trimmed
- `lat`, `lon`, `seen_pos` — position and its age in seconds
- `alt_baro` — barometric altitude, **can be the string `"ground"` instead of a number**
- `alt_geom`, `gs`, `track`, `baro_rate`
- `squawk` — string, not a number (e.g. `"7700"`)
- `category`, `r` (registration), `t` (type code), `desc`
- `dbFlags` — bitmask; bit 1 = military
- `rssi`, `messages`, `seen`

Do not invent fields that aren't listed here. If something is needed that
isn't confirmed above, ask — verify against docs or a live file rather than
guessing.

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
- Full-screen map, bottom bar with three icon buttons (own inline SVG): List
  (sortable, clickable, click centers map), Stats (counts, msgs/sec, max
  range, time chart), Settings (theme, units, altitude filter, layer
  visibility).
- Panels are bottom sheets on phones, can be a side panel on large screens;
  closable via X or Android/iOS back-gesture. Map stays visible on desktop.
- **Dark theme is the default** — this is a radar display, must be readable
  at night without glare. Color theme: green, blue, black.
- Plane icon rotates to heading. Click shows trail + basic info with a "show
  more details" button (still a stub — see `TODO.md`).
- Trail color follows altitude, smooth gradient: green below 10,000 ft, blue
  in the 10,000–25,000 ft band, red trending to dark red at 40,000 ft.
- Signal loss handling: no update for 3s → aircraft starts fading toward red;
  fully red by 10s, **stays fully red for another 10s** (found via real use —
  it was disappearing too abruptly), actually removed at 20s
  (`FADE_START_MS`/`FADE_END_MS`/`REMOVE_MS` in `app.js`). If it reappears,
  the trail segment between last contact and reappearance is drawn grey.
  After 5 minutes with no update, give up on it returning.
- Type + callsign label appears at appropriate zoom levels.
- **Trails are opt-in per Settings → Map**: `trailsEnabled` (on/off) +
  `trailMode` (`click` — only the selected aircraft, default; `all` — every
  aircraft's trail drawn simultaneously, colors included). The grey
  signal-loss segment and the altitude-colored segments are the *same*
  per-hex feature list (`public/js/trail.js`, entries carry an `isGap` flag)
  rendered into one shared `mlpr-trail` GeoJSON source — there is no separate
  always-on gap layer anymore. (There used to be one that rendered
  unconditionally regardless of selection — that was the bug reported and
  fixed here: grey trails appearing without clicking anything and never
  clearing.)
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
