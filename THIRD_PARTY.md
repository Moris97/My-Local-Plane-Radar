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
