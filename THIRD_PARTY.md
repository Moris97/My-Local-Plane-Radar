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
| maplibre-gl | ^5.0.0 | BSD-3-Clause | Map rendering in the browser. Served from `node_modules` (never committed) — no CDN, works offline. |

## Data

| Dataset | License | Notes |
|---|---|---|
| Natural Earth 1:10m | Public domain | Fetched by `scripts/fetch-mapdata.sh`, never committed to the repo. |
