function round5(value) {
  return typeof value === 'number' ? Math.round(value * 1e5) / 1e5 : value;
}

function roundAltitude(value) {
  return typeof value === 'number' ? Math.round(value / 25) * 25 : value;
}

export function toWireSnapshot(snapshot) {
  return {
    now: snapshot.now,
    aircraft: snapshot.aircraft.map((aircraft) => ({
      ...aircraft,
      lat: round5(aircraft.lat),
      lon: round5(aircraft.lon),
      altBaro: roundAltitude(aircraft.altBaro),
      altGeom: roundAltitude(aircraft.altGeom),
    })),
  };
}
