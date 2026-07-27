// Emitter category (ADS-B), the subset actually useful to show -- A0/B0/C0/D*
// mean "no info" or are reserved, so they're deliberately left unmapped and
// just fall back to the raw code.
const CATEGORY_LABELS = {
  A1: 'Light',
  A2: 'Small',
  A3: 'Large',
  A4: 'High vortex large',
  A5: 'Heavy',
  A6: 'High performance',
  A7: 'Rotorcraft',
  B1: 'Glider/sailplane',
  B2: 'Lighter-than-air',
  B3: 'Parachutist',
  B4: 'Ultralight',
  B6: 'UAV/drone',
  B7: 'Space vehicle',
  C1: 'Emergency vehicle',
  C2: 'Service vehicle',
  C3: 'Point obstacle',
  C4: 'Cluster obstacle',
  C5: 'Line obstacle',
};

const SOURCE_TYPE_LABELS = {
  adsb_icao: 'ADS-B (ICAO)',
  adsb_icao_nt: 'ADS-B (ICAO, non-transponder)',
  adsr_icao: 'ADS-R (ICAO)',
  tisb_icao: 'TIS-B (ICAO)',
  adsc: 'ADS-C',
  mlat: 'MLAT (multilateration)',
  other: 'Other',
  mode_s: 'Mode S (no position)',
  adsb_other: 'ADS-B (non-ICAO)',
  adsr_other: 'ADS-R (non-ICAO)',
  tisb_other: 'TIS-B (non-ICAO)',
  tisb_trackfile: 'TIS-B (track file)',
};

const EMERGENCY_LABELS = {
  general: 'General emergency',
  lifeguard: 'Lifeguard/medical',
  minfuel: 'Minimum fuel',
  nordo: 'Radio failure (NORDO)',
  unlawful: 'Unlawful interference',
  downed: 'Downed aircraft',
  reserved: 'Reserved',
};

const NAV_MODE_LABELS = {
  autopilot: 'Autopilot',
  vnav: 'VNAV',
  althold: 'Altitude hold',
  approach: 'Approach',
  lnav: 'LNAV',
  tcas: 'TCAS',
};

const SIL_TYPE_LABELS = {
  unknown: 'Unknown',
  perhour: 'Per hour',
  persample: 'Per sample',
};

function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function round(value, decimals = 0) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function altitudeValue(aircraft, altKey) {
  if (altKey === 'altBaro' && aircraft.onGround) return 'ground';
  const v = num(aircraft[altKey]);
  return v === null ? null : `${round(v)} ft`;
}

function rateValue(aircraft, key) {
  const v = num(aircraft[key]);
  if (v === null) return null;
  const rounded = round(v);
  return `${rounded > 0 ? '+' : ''}${rounded} ft/min`;
}

function speedValue(aircraft, key) {
  const v = num(aircraft[key]);
  return v === null ? null : `${round(v)} kt`;
}

function degreesValue(aircraft, key) {
  const v = num(aircraft[key]);
  return v === null ? null : `${round(v)}°`;
}

// pairId lets two independent tiles (e.g. flight/registration) be rendered
// side by side as one row even when one of them is missing for a given
// aircraft -- without it, plain array order would drift: if an earlier tile
// in the list is filtered out, later ones shift into the "wrong" half of a
// row and an unrelated tile ends up paired with the next one by accident.
function tile(key, labelKey, format, pairId = null) {
  return {
    type: 'tile',
    build(aircraft) {
      const value = format(aircraft);
      return value == null || value === '' ? null : { key, labelKey, value, pairId };
    },
  };
}

function cluster(labelKey, parts) {
  return {
    type: 'cluster',
    build(aircraft) {
      const chips = parts
        .map(({ key, labelKey: partLabelKey, format }) => {
          const value = format(aircraft);
          return value == null || value === '' ? null : { key, labelKey: partLabelKey, value };
        })
        .filter(Boolean);
      return chips.length === 0 ? null : { labelKey, chips };
    },
  };
}

function flagTile(key, labelKey) {
  return tile(key, labelKey, (a) => (a[key] === true ? t_TRUE_MARKER : null));
}

// Sentinel: a flag tile's "value" is just a marker meaning "show the label
// as an on/off badge" -- the real text comes from labelKey at render time.
const t_TRUE_MARKER = 'flag';

const CORE_SPEC = [
  tile('flight', 'detailFlight', (a) => a.flight ?? null, 'p-identity'),
  tile('registration', 'detailRegistration', (a) => a.registration ?? null, 'p-identity'),
  tile('typeCode', 'detailType', (a) => a.typeCode ?? null, 'p-type'),
  tile('category', 'detailCategory', (a) => (a.category ? (CATEGORY_LABELS[a.category] ?? a.category) : null), 'p-type'),
  tile('squawk', 'detailSquawk', (a) => a.squawk ?? null, 'p-squawk'),
  tile('emergency', 'detailEmergency', (a) => (a.emergency ? (EMERGENCY_LABELS[a.emergency] ?? a.emergency) : null), 'p-squawk'),
  tile('altBaro', 'detailAltitude', (a) => altitudeValue(a, 'altBaro'), 'p-altitude'),
  tile('baroRate', 'detailVerticalRate', (a) => rateValue(a, 'baroRate'), 'p-altitude'),
  cluster('detailSpeedGroup', [
    { key: 'gs', labelKey: 'detailGs', format: (a) => speedValue(a, 'gs') },
    { key: 'ias', labelKey: 'detailIas', format: (a) => speedValue(a, 'ias') },
    { key: 'tas', labelKey: 'detailTas', format: (a) => speedValue(a, 'tas') },
    { key: 'mach', labelKey: 'detailMach', format: (a) => (num(a.mach) === null ? null : round(a.mach, 2)) },
  ]),
];

const EXTRA_SPEC = [
  cluster('detailHeadingGroup', [
    { key: 'track', labelKey: 'detailTrack', format: (a) => degreesValue(a, 'track') },
    { key: 'magHeading', labelKey: 'detailMagHeading', format: (a) => degreesValue(a, 'magHeading') },
    { key: 'trueHeading', labelKey: 'detailTrueHeading', format: (a) => degreesValue(a, 'trueHeading') },
    { key: 'roll', labelKey: 'detailRoll', format: (a) => degreesValue(a, 'roll') },
    { key: 'trackRate', labelKey: 'detailTrackRate', format: (a) => (num(a.trackRate) === null ? null : `${round(a.trackRate, 1)}°/s`) },
  ]),
  tile('altGeom', 'detailAltGeom', (a) => altitudeValue(a, 'altGeom'), 'p-altgeom'),
  tile('geomRate', 'detailGeomRate', (a) => rateValue(a, 'geomRate'), 'p-altgeom'),
  cluster('detailNavGroup', [
    { key: 'navAltitudeMcp', labelKey: 'detailNavMcp', format: (a) => altitudeValue(a, 'navAltitudeMcp') },
    { key: 'navAltitudeFms', labelKey: 'detailNavFms', format: (a) => altitudeValue(a, 'navAltitudeFms') },
    { key: 'navHeading', labelKey: 'detailNavHeading', format: (a) => degreesValue(a, 'navHeading') },
    { key: 'navQnh', labelKey: 'detailNavQnh', format: (a) => (num(a.navQnh) === null ? null : `${round(a.navQnh)} hPa`) },
  ]),
  tile('navModes', 'detailNavModes', (a) =>
    Array.isArray(a.navModes) && a.navModes.length > 0
      ? a.navModes.map((m) => NAV_MODE_LABELS[m] ?? m).join(', ')
      : null,
  ),
  tile('desc', 'detailDesc', (a) => a.desc ?? null),
  tile('version', 'detailVersion', (a) => (num(a.version) === null ? null : `ADS-B v${a.version}`), 'p-source'),
  tile('sourceType', 'detailSourceType', (a) => (a.sourceType ? (SOURCE_TYPE_LABELS[a.sourceType] ?? a.sourceType) : null), 'p-source'),
  flagTile('military', 'detailMilitary'),
  flagTile('interesting', 'detailInteresting'),
  flagTile('pia', 'detailPia'),
  flagTile('ladd', 'detailLadd'),
  flagTile('alert', 'detailAlert'),
  flagTile('spi', 'detailSpi'),
  cluster('detailWeatherGroup', [
    { key: 'wd', labelKey: 'detailWd', format: (a) => degreesValue(a, 'wd') },
    { key: 'ws', labelKey: 'detailWs', format: (a) => speedValue(a, 'ws') },
    { key: 'oat', labelKey: 'detailOat', format: (a) => (num(a.oat) === null ? null : `${round(a.oat)}°C`) },
    { key: 'tat', labelKey: 'detailTat', format: (a) => (num(a.tat) === null ? null : `${round(a.tat)}°C`) },
  ]),
  tile('rssi', 'detailRssi', (a) => (num(a.rssi) === null ? null : `${round(a.rssi, 1)} dBFS`), 'p-signal'),
  tile('messages', 'detailMessages', (a) => (num(a.messages) === null ? null : String(a.messages)), 'p-signal'),
  tile('seen', 'detailSeen', (a) => (num(a.seen) === null ? null : `${round(a.seen, 1)} s`), 'p-seen'),
  tile('seenPos', 'detailSeenPos', (a) => (num(a.seenPos) === null ? null : `${round(a.seenPos, 1)} s`), 'p-seen'),
  cluster('detailQualityGroup', [
    { key: 'nic', labelKey: 'detailNic', format: (a) => (num(a.nic) === null ? null : String(a.nic)) },
    { key: 'rc', labelKey: 'detailRc', format: (a) => (num(a.rc) === null ? null : `${a.rc} m`) },
    { key: 'nicBaro', labelKey: 'detailNicBaro', format: (a) => (num(a.nicBaro) === null ? null : String(a.nicBaro)) },
    { key: 'nacP', labelKey: 'detailNacP', format: (a) => (num(a.nacP) === null ? null : String(a.nacP)) },
    { key: 'nacV', labelKey: 'detailNacV', format: (a) => (num(a.nacV) === null ? null : String(a.nacV)) },
    { key: 'sil', labelKey: 'detailSil', format: (a) => (num(a.sil) === null ? null : String(a.sil)) },
    { key: 'silType', labelKey: 'detailSilType', format: (a) => (a.silType ? (SIL_TYPE_LABELS[a.silType] ?? a.silType) : null) },
    { key: 'gva', labelKey: 'detailGva', format: (a) => (num(a.gva) === null ? null : String(a.gva)) },
    { key: 'sda', labelKey: 'detailSda', format: (a) => (num(a.sda) === null ? null : String(a.sda)) },
  ]),
  tile('hex', 'detailHex', (a) => a.hex?.toUpperCase() ?? null),
];

function buildFrom(aircraft, spec) {
  return spec.map((entry) => entry.build(aircraft)).filter(Boolean);
}

export function buildAircraftDetailTiles(aircraft) {
  return {
    core: buildFrom(aircraft, CORE_SPEC),
    extra: buildFrom(aircraft, EXTRA_SPEC),
  };
}

export const FLAG_VALUE_MARKER = t_TRUE_MARKER;
