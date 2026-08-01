const FEET_PER_METER = 1 / 0.3048;
const KM_PER_NM = 1.852;

export function formatAltitude(feet, units) {
  if (typeof feet !== 'number') return null;
  return units === 'metric' ? `${Math.round(feet / FEET_PER_METER)} m` : `${Math.round(feet)} ft`;
}

export function formatSpeed(knots, units) {
  if (typeof knots !== 'number') return null;
  return units === 'metric' ? `${Math.round(knots * KM_PER_NM)} km/h` : `${Math.round(knots)} kt`;
}

export function formatVerticalRate(feetPerMinute, units) {
  if (typeof feetPerMinute !== 'number') return null;
  const value =
    units === 'metric'
      ? Math.round(((feetPerMinute / FEET_PER_METER / 60) * 10)) / 10
      : Math.round(feetPerMinute);
  const unit = units === 'metric' ? 'm/s' : 'ft/min';
  return `${value > 0 ? '+' : ''}${value} ${unit}`;
}

export function formatDistance(km, units) {
  if (typeof km !== 'number') return null;
  return units === 'imperial' ? `${Math.round(km / KM_PER_NM)} nm` : `${Math.round(km)} km`;
}

// The three below are for an *editable* distance (the trigger-area
// editor's radius field), where formatDistance's baked-in rounding and
// unit suffix get in the way: a form field needs the bare number in the
// user's own unit, and needs to convert what they type back to the km the
// server stores. Deliberately no rounding here -- rounding a radius on
// every keystroke/drag would make it impossible to type "12.5".
export function distanceUnitLabel(units) {
  return units === 'imperial' ? 'nm' : 'km';
}

export function kmToDisplayDistance(km, units) {
  return units === 'imperial' ? km / KM_PER_NM : km;
}

export function displayDistanceToKm(value, units) {
  return units === 'imperial' ? value * KM_PER_NM : value;
}
