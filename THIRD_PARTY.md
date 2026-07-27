# Third-party dependencies

Allowed licenses: MIT, ISC, BSD-2-Clause, BSD-3-Clause, Apache-2.0, CC0,
public domain. GPL/LGPL require explicit approval before adding. AGPL is
never allowed.

This table is kept in sync every time a new package is added to `package.json`.
Transitive dependencies were scanned for GPL/AGPL license strings on 2026-07-26
(Stage 1) — none found.

| Package | Version | License | Purpose |
|---|---|---|---|
| fastify | ^5.0.0 | MIT | HTTP server, serves the static frontend. |
| @fastify/static | ^10.1.2 | MIT | Static file serving for `public/` and the vendored MapLibre bundle; hand-rolling this risks path-traversal bugs. Pinned to >=10.1.2 (fixes GHSA-pr96-94w5-mx2h and related path-traversal/auth-bypass advisories present in <=10.1.1). |
| ws | ^8.18.0 | MIT | Raw WebSocket server for pushing aircraft snapshots to the browser. |
| maplibre-gl | ^5.0.0 | BSD-3-Clause | Map rendering in the browser. Served from `node_modules` (never committed) — no CDN, works offline. BSD-3-Clause only requires retaining the license text (this table + `LICENSE`), not an on-map credit — we show a small "MapLibre" link in the UI anyway as a courtesy, in both online and offline mode. |

### Dev-only (never shipped to the Pi)

| Package | Version | License | Purpose |
|---|---|---|---|
| playwright | ^1.62.0 | Apache-2.0 | Headless-browser smoke testing during development (screenshots, DOM/interaction checks). Not used at runtime, not deployed. |

## Data

| Dataset | License | Notes |
|---|---|---|
| Natural Earth 1:10m (coastline, borders, rivers, major cities) | Public domain | Fetched by `scripts/fetch-mapdata.sh` from the [martynafford/natural-earth-geojson](https://github.com/martynafford/natural-earth-geojson) mirror (repo itself CC0-1.0), which pre-converts Natural Earth's shapefiles to GeoJSON. The script strips unused attributes, rounds coordinates to 4 decimal places, and filters rivers/cities by `scalerank` before writing to `data/naturalearth/` (~12 MB total, never committed). Used for the **offline** basemap mode. |
| OpenFreeMap vector tiles (`https://tiles.openfreemap.org`) | ODbL (data) / BSD-3-Clause (OpenMapTiles schema, CC-BY tiles service) | Not an npm package — a map tile/data source, requested directly by the browser via MapLibre GL JS (already a dependency), no API key or account needed. Used for the **online** (default) basemap mode. Our own style (`public/mapstyles/online-dark.json`) references their `openmaptiles` vector source and glyph server; we do not use their ready-made liberty/positron/bright styles. **ODbL requires attribution** — shown as a small custom-styled "© OpenStreetMap contributors" link (`#mlpr-attribution`), visible only in online mode. |
| Planespotters Photo API (`https://api.planespotters.net/pub/photos/hex/{hex}`) | Free public API, own [Terms of Use](https://www.planespotters.net/photo/api) (not an OSS license) | Not an npm package — fetched directly by the browser (`public/js/aircraft-panel.js`) when the aircraft details panel is opened, keyed by ICAO hex. No API key. Their terms require: browser-side requests only (server-to-server needs a descriptive User-Agent + contact info, which is why this is *never* proxied through our Fastify server); the photographer credited in text next to the image (we show a "Photo: {photographer}" line linking to the Planespotters photo page, using the API's own `link` URL unmodified); image binaries loaded directly from their `thumbnail_large.src` URL, never downloaded/re-hosted/proxied by us. Graceful degradation: no photo found, or the fetch failing for any reason, just omits the photo section — never an error shown to the user. |
| [wiedehopf/tar1090-db](https://github.com/wiedehopf/tar1090-db) `aircraft.csv.gz` (aircraft registration/type database, sourced from [Mictronics](https://www.mictronics.de/aircraft-database/)) | No LICENSE file in the repo — distributed openly by readsb's own maintainer specifically as the documented `--db-file` source (see readsb's README), the standard way essentially every ADS-B hobbyist project gets this data. Not a code dependency; only concern here is *our* redistribution, and we don't redistribute it — it's fetched onto the *user's own* readsb install, same as they'd do manually per upstream's own instructions. | Not fetched by MLPR itself — `scripts/install.sh` downloads it to `/usr/local/share/tar1090/aircraft.csv.gz` and wires it into readsb's own `--db-file` flag (readsb is a separate process/service, not part of this repo). Without it, readsb never reports registration/aircraft-type/dbFlags for any aircraft, which silently breaks parts of the aircraft details panel and notifications. Best-effort and idempotent, see CLAUDE.md's "Production deployment" section. |
