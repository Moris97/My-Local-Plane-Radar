const MILITARY_DB_FLAG = 1;

function trimOrUndefined(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function numberOrUndefined(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function normalizeAircraft(raw) {
  if (typeof raw?.hex !== 'string' || raw.hex.length === 0) {
    return null;
  }

  const onGround = raw.alt_baro === 'ground';

  return {
    hex: raw.hex,
    flight: trimOrUndefined(raw.flight),
    lat: numberOrUndefined(raw.lat),
    lon: numberOrUndefined(raw.lon),
    seenPos: numberOrUndefined(raw.seen_pos),
    onGround,
    altBaro: onGround ? undefined : numberOrUndefined(raw.alt_baro),
    altGeom: numberOrUndefined(raw.alt_geom),
    gs: numberOrUndefined(raw.gs),
    track: numberOrUndefined(raw.track),
    baroRate: numberOrUndefined(raw.baro_rate),
    squawk: typeof raw.squawk === 'string' ? raw.squawk : undefined,
    category: typeof raw.category === 'string' ? raw.category : undefined,
    registration: trimOrUndefined(raw.r),
    typeCode: trimOrUndefined(raw.t),
    desc: trimOrUndefined(raw.desc),
    military: typeof raw.dbFlags === 'number' ? (raw.dbFlags & MILITARY_DB_FLAG) !== 0 : false,
    rssi: numberOrUndefined(raw.rssi),
    messages: numberOrUndefined(raw.messages),
    seen: numberOrUndefined(raw.seen),
  };
}
