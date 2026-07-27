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
