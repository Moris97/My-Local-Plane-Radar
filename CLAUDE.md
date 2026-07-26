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
- Basemap: Natural Earth 1:10m GeoJSON (coastlines, borders, rivers, major
  cities), ~20 MB, public domain. Fetched by `scripts/fetch-mapdata.sh` at
  install time — **never committed**. Design the map layer so a later swap to
  Protomaps `.pmtiles` is possible, but do not implement that swap now.
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
  more details" button.
- Trail color follows altitude, smooth gradient: green below 10,000 ft, blue
  in the 10,000–25,000 ft band, red trending to dark red at 40,000 ft.
- Signal loss handling: no update for 3s → aircraft starts fading toward red;
  gone entirely at 10s. If it reappears, the trail segment between last
  contact and reappearance is drawn grey. After 5 minutes with no update, give
  up on it returning.
- Type + callsign label appears at appropriate zoom levels.

## Notification engine (design now, do not implement yet)

Condition -> action rules, configured in YAML or JSON. Planned triggers:
squawk 7500/7600/7700, military flag in `dbFlags`, watched hex/registration,
entering a radius around home or dropping below an altitude, first-time-seen
aircraft, new range record. Delivery: **ntfy first** (single POST, no certs,
works on Android/iOS); Web Push deferred (needs secure context, awkward over
plain HTTP on a LAN). **Every rule needs a per-hex cooldown (default 30 min)
and deduplication** — otherwise one aircraft circling a radius boundary spams
dozens of alerts.

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
