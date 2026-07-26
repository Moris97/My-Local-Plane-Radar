const LAYERS = [
  {
    id: 'ne-coastline',
    url: '/mapdata/coastline.geojson',
    type: 'line',
    paint: { 'line-color': '#2f6b4f', 'line-width': 1 },
  },
  {
    id: 'ne-borders',
    url: '/mapdata/borders.geojson',
    type: 'line',
    paint: { 'line-color': '#35506b', 'line-width': 0.75, 'line-dasharray': [4, 3] },
  },
  {
    id: 'ne-rivers',
    url: '/mapdata/rivers.geojson',
    type: 'line',
    paint: { 'line-color': '#1f4f73', 'line-width': 0.75 },
    minzoom: 2,
  },
  {
    id: 'ne-cities',
    url: '/mapdata/cities.geojson',
    type: 'circle',
    paint: { 'circle-color': '#5b7a94', 'circle-radius': 2 },
    minzoom: 3,
  },
];

export const BASEMAP_LAYER_IDS = LAYERS.map((layer) => layer.id);

export function addBasemapLayers(map) {
  for (const layer of LAYERS) {
    map.addSource(layer.id, { type: 'geojson', data: layer.url });
    map.addLayer({
      id: layer.id,
      type: layer.type,
      source: layer.id,
      minzoom: layer.minzoom ?? 0,
      paint: layer.paint,
    });
  }
}
