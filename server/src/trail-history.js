const MAX_POINTS_PER_AIRCRAFT = 200;

const history = new Map();

export function recordPosition(hex, point) {
  let points = history.get(hex);
  if (!points) {
    points = [];
    history.set(hex, points);
  }
  points.push(point);
  if (points.length > MAX_POINTS_PER_AIRCRAFT) {
    points.splice(0, points.length - MAX_POINTS_PER_AIRCRAFT);
  }
}

export function getTrail(hex) {
  return history.get(hex) ?? [];
}

export function getAllTrails() {
  return Object.fromEntries(history);
}

export function evictStaleTrails(activeHexes) {
  for (const hex of history.keys()) {
    if (!activeHexes.has(hex)) {
      history.delete(hex);
    }
  }
}

export function resetTrailHistory() {
  history.clear();
}
