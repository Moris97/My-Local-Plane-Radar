# My Local Plane Radar (MLPR)

A self-hosted web interface for a local ADS-B receiver running on Raspberry Pi.

MLPR reads the `aircraft.json` file produced by [readsb](https://github.com/wiedehopf/readsb)
(wiedehopf fork) and serves a live map, receiver statistics, and a rule-based
notification engine (ntfy) — without touching readsb itself.

**Status: Stage 4 of the build plan.** Live map with delta updates, signal-loss
fading, altitude-colored trails, a basemap, a bottom-bar UI (List/Stats/
Settings), receiver stats (from readsb's own `stats.json`, including a
24h history chart) and SQLite-backed daily aggregates are in place. The
notification engine is still ahead — see [CLAUDE.md](./CLAUDE.md) for the
architecture and the staged build plan.

## Running it

```
npm install
./scripts/fetch-mapdata.sh   # one-time: downloads the basemap (~12 MB) into data/naturalearth/
npm start                    # MLPR_PORT (default 1090), MLPR_SOURCE=file|http|replay
```

Then open `http://<host>:1090/`.

## Why

Replacing a heavyweight Virtual Radar Server setup with something lightweight,
hackable, and built around one specific goal: get notified when something
interesting shows up in range (military aircraft, emergency squawks, a new
personal range record, a watched registration, ...).

## Hardware target

- **Production**: Raspberry Pi 3 (1 GB RAM, aarch64), Raspberry Pi OS Lite,
  headless, readsb running as a systemd service.
- **Development**: Debian on WSL2 (x86_64), deployed to the Pi via `git pull`
  + systemd restart.

The 1 GB RAM / SD card constraint is treated as a hard requirement throughout,
not an afterthought — see the performance rules in [CLAUDE.md](./CLAUDE.md).

## Stack

- Backend: Node.js (>=22.13.0) + Fastify + `ws`, state in memory, `node:sqlite`
  for events/aggregates only.
- Frontend: plain ES modules + [MapLibre GL JS](https://maplibre.org/) — no
  framework, no build step.
- Basemap: Natural Earth 1:10m (fetched by script, not committed).

## License

MIT — see [LICENSE](./LICENSE). Third-party dependency licenses are tracked in
[THIRD_PARTY.md](./THIRD_PARTY.md). This project only reads the JSON file
readsb writes to disk; it does not link against or embed readsb, tar1090, or
dump1090 code.

## Relationship to readsb

readsb is GPL-licensed. MLPR is a separate process that only reads the
`aircraft.json` file readsb writes to `/run/readsb/`. There is no linking, no
shared code, and no code copied from readsb, tar1090, or dump1090.
