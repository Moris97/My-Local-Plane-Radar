import { mkdir, writeFile } from 'node:fs/promises';

const NE_BASE = 'https://raw.githubusercontent.com/martynafford/natural-earth-geojson/master/10m';
const COORDINATE_PRECISION = 4;
const OUTPUT_DIR = new URL('../data/naturalearth/', import.meta.url);

const LAYERS = [
  {
    name: 'coastline',
    url: `${NE_BASE}/physical/ne_10m_coastline.json`,
    keepProps: [],
  },
  {
    name: 'borders',
    url: `${NE_BASE}/cultural/ne_10m_admin_0_boundary_lines_land.json`,
    keepProps: ['name'],
  },
  {
    name: 'rivers',
    url: `${NE_BASE}/physical/ne_10m_rivers_lake_centerlines.json`,
    keepProps: ['name'],
    filter: (props) => (props.scalerank ?? 99) <= 6,
  },
  {
    name: 'cities',
    url: `${NE_BASE}/cultural/ne_10m_populated_places_simple.json`,
    keepProps: ['name', 'nameascii'],
    filter: (props) => (props.scalerank ?? 99) <= 4,
  },
  {
    // Natural Earth's own airport set -- public domain like everything
    // else here, so the offline map still needs no data attribution (an
    // OSM/Overpass export would have been ODbL and brought an attribution
    // requirement into offline mode). Already curated to notable airports
    // (~900 worldwide); 'small', 'spaceport' and military-only fields are
    // dropped, keeping the 'major'/'mid' ones (including joint civil/
    // military, e.g. "major and military").
    name: 'airports',
    url: `${NE_BASE}/cultural/ne_10m_airports.json`,
    keepProps: ['name', 'code', 'major', 'rank'],
    filter: (props) => /\b(major|mid)\b/.test(props.type ?? '') && props.type !== 'military mid' && props.type !== 'military major',
    // Shorter property names the offline layer reads directly: the label
    // is the IATA code, falling back to ICAO for the few without one.
    transform: (props) => ({
      name: props.name,
      code: props.iata_code || props.gps_code || props.abbrev,
      major: /\bmajor\b/.test(props.type),
      rank: props.scalerank ?? 9,
    }),
  },
];

function roundCoordinates(coords, precision) {
  if (typeof coords[0] === 'number') {
    return coords.map((value) => Number(value.toFixed(precision)));
  }
  return coords.map((value) => roundCoordinates(value, precision));
}

async function processLayer(layer) {
  console.log(`Fetching ${layer.name}...`);
  const response = await fetch(layer.url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${layer.name}: HTTP ${response.status}`);
  }
  const data = await response.json();

  const features = data.features
    .filter((feature) => feature.geometry !== null)
    .filter((feature) => !layer.filter || layer.filter(feature.properties))
    .map((feature) => {
      const source = layer.transform ? layer.transform(feature.properties) : feature.properties;
      const properties = {};
      for (const key of layer.keepProps) {
        if (source[key] !== undefined) {
          properties[key] = source[key];
        }
      }
      return {
        type: 'Feature',
        properties,
        geometry: {
          type: feature.geometry.type,
          coordinates: roundCoordinates(feature.geometry.coordinates, COORDINATE_PRECISION),
        },
      };
    });

  return { type: 'FeatureCollection', features };
}

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });

  // `--only airports` fetches just the named layer(s) -- lets install.sh
  // add a layer introduced after an install's basemap was first fetched
  // without re-downloading the rest.
  const onlyIndex = process.argv.indexOf('--only');
  const only = onlyIndex >= 0 ? new Set(process.argv.slice(onlyIndex + 1)) : null;

  for (const layer of LAYERS.filter((l) => !only || only.has(l.name))) {
    const geojson = await processLayer(layer);
    const outPath = new URL(`${layer.name}.geojson`, OUTPUT_DIR);
    await writeFile(outPath, JSON.stringify(geojson));
    console.log(`Wrote ${layer.name}.geojson (${geojson.features.length} features)`);
  }

  console.log('Done. Source: Natural Earth (public domain) via martynafford/natural-earth-geojson (CC0).');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
