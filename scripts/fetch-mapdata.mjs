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
      const properties = {};
      for (const key of layer.keepProps) {
        if (feature.properties[key] !== undefined) {
          properties[key] = feature.properties[key];
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

  for (const layer of LAYERS) {
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
