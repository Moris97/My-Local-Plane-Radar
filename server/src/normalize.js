const MILITARY_DB_FLAG = 1;
const INTERESTING_DB_FLAG = 2;
const PIA_DB_FLAG = 4;
const LADD_DB_FLAG = 8;

function trimOrUndefined(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function numberOrUndefined(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function booleanOrUndefined(value) {
  return typeof value === 'number' ? value !== 0 : undefined;
}

function stringArrayOrUndefined(value) {
  return Array.isArray(value) && value.every((v) => typeof v === 'string') ? value : undefined;
}

export function normalizeAircraft(raw) {
  if (typeof raw?.hex !== 'string' || raw.hex.length === 0) {
    return null;
  }

  const onGround = raw.alt_baro === 'ground';
  const dbFlags = typeof raw.dbFlags === 'number' ? raw.dbFlags : 0;

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
    ias: numberOrUndefined(raw.ias),
    tas: numberOrUndefined(raw.tas),
    mach: numberOrUndefined(raw.mach),
    track: numberOrUndefined(raw.track),
    trackRate: numberOrUndefined(raw.track_rate),
    roll: numberOrUndefined(raw.roll),
    magHeading: numberOrUndefined(raw.mag_heading),
    trueHeading: numberOrUndefined(raw.true_heading),
    baroRate: numberOrUndefined(raw.baro_rate),
    geomRate: numberOrUndefined(raw.geom_rate),
    squawk: typeof raw.squawk === 'string' ? raw.squawk : undefined,
    emergency: trimOrUndefined(raw.emergency) === 'none' ? undefined : trimOrUndefined(raw.emergency),
    category: typeof raw.category === 'string' ? raw.category : undefined,
    version: numberOrUndefined(raw.version),
    sourceType: trimOrUndefined(raw.type),
    registration: trimOrUndefined(raw.r),
    typeCode: trimOrUndefined(raw.t),
    desc: trimOrUndefined(raw.desc),
    military: (dbFlags & MILITARY_DB_FLAG) !== 0,
    interesting: (dbFlags & INTERESTING_DB_FLAG) !== 0,
    pia: (dbFlags & PIA_DB_FLAG) !== 0,
    ladd: (dbFlags & LADD_DB_FLAG) !== 0,
    navQnh: numberOrUndefined(raw.nav_qnh),
    navAltitudeMcp: numberOrUndefined(raw.nav_altitude_mcp),
    navAltitudeFms: numberOrUndefined(raw.nav_altitude_fms),
    navHeading: numberOrUndefined(raw.nav_heading),
    navModes: stringArrayOrUndefined(raw.nav_modes),
    nic: numberOrUndefined(raw.nic),
    rc: numberOrUndefined(raw.rc),
    nicBaro: numberOrUndefined(raw.nic_baro),
    nacP: numberOrUndefined(raw.nac_p),
    nacV: numberOrUndefined(raw.nac_v),
    sil: numberOrUndefined(raw.sil),
    silType: trimOrUndefined(raw.sil_type),
    gva: numberOrUndefined(raw.gva),
    sda: numberOrUndefined(raw.sda),
    alert: booleanOrUndefined(raw.alert),
    spi: booleanOrUndefined(raw.spi),
    rssi: numberOrUndefined(raw.rssi),
    messages: numberOrUndefined(raw.messages),
    seen: numberOrUndefined(raw.seen),
    wd: numberOrUndefined(raw.wd),
    ws: numberOrUndefined(raw.ws),
    oat: numberOrUndefined(raw.oat),
    tat: numberOrUndefined(raw.tat),
  };
}
