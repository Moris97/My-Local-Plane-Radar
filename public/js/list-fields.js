// Flat catalog of every field the List's configurable columns/sort can use --
// the same CORE_SPEC/EXTRA_SPEC field set aircraft-details.js shows in the
// aircraft details panel, flattened out of that file's tile/cluster grouping
// (grouping into paired tiles/chip clusters is a details-panel-only display
// concern, not meaningful for a table column), plus two additions:
// `distance` (new -- home location to aircraft position) and `military`
// (already existed as a details-panel flag that's hidden unless true; here
// it's an always-visible boolean column instead, since a table column being
// blank half the time is confusing in a way an omitted panel tile isn't).
//
// Each entry: { key, labelKey, boolean?, format(aircraft, units, ctx), sortValue(aircraft, ctx) }.
// `format` returns the already-unit-formatted display value (or true/false
// for `boolean` entries -- list.js converts those to t('yes')/t('no')).
// `sortValue` returns the raw comparable value, mirroring the existing
// "sort the real value, format separately for display" split list.js already
// used for altitude before this catalog existed. `ctx` is `{ home }` --
// only `distance` reads it.
import { t } from './i18n.js';
import { formatDistance } from './units.js';
import { distanceKm } from './geo.js';
import {
  num,
  round,
  degreesValue,
  rateValue,
  speedValue,
  altitudeValue,
  CATEGORY_LABELS,
  SOURCE_TYPE_LABELS,
  EMERGENCY_LABELS,
  NAV_MODE_LABELS,
  SIL_TYPE_LABELS,
} from './aircraft-details.js';

function textField(key, labelKey) {
  return {
    key,
    labelKey,
    format: (a) => a[key] ?? null,
    sortValue: (a) => a[key] ?? null,
  };
}

function numberField(key, labelKey, suffix = '') {
  return {
    key,
    labelKey,
    format: (a) => (num(a[key]) === null ? null : `${a[key]}${suffix}`),
    sortValue: (a) => num(a[key]),
  };
}

function altitudeField(key, labelKey) {
  return {
    key,
    labelKey,
    format: (a, units) => altitudeValue(a, key, units),
    sortValue: (a) => num(a[key]),
  };
}

function rateField(key, labelKey) {
  return {
    key,
    labelKey,
    format: (a, units) => rateValue(a, key, units),
    sortValue: (a) => num(a[key]),
  };
}

function speedField(key, labelKey) {
  return {
    key,
    labelKey,
    format: (a, units) => speedValue(a, key, units),
    sortValue: (a) => num(a[key]),
  };
}

function degreesField(key, labelKey) {
  return {
    key,
    labelKey,
    format: (a) => degreesValue(a, key),
    sortValue: (a) => num(a[key]),
  };
}

function labeledField(key, labelKey, labels) {
  return {
    key,
    labelKey,
    format: (a) => (a[key] ? (labels[a[key]] ?? a[key]) : null),
    sortValue: (a) => (a[key] ? (labels[a[key]] ?? a[key]) : null),
  };
}

function booleanField(key, labelKey) {
  return {
    key,
    labelKey,
    boolean: true,
    format: (a) => a[key] === true,
    sortValue: (a) => (a[key] === true ? 1 : 0),
  };
}

const LIST_FIELDS = [
  // Identity / broadcast basics.
  {
    key: 'flight',
    labelKey: 'detailFlight',
    // Falls back to the hex when the callsign is blank -- matches the
    // pre-catalog behavior exactly (see NO_POSITION_ICON handling in
    // list.js, which still special-cases this key for the crossed-out
    // pin icon).
    format: (a) => a.flight || a.hex,
    sortValue: (a) => (a.flight || '').trim() || a.hex,
  },
  textField('registration', 'detailRegistration'),
  textField('typeCode', 'detailType'),
  {
    key: 'hex',
    labelKey: 'detailHex',
    format: (a) => a.hex?.toUpperCase() ?? null,
    sortValue: (a) => a.hex ?? null,
  },
  textField('squawk', 'detailSquawk'),
  labeledField('category', 'detailCategory', CATEGORY_LABELS),
  labeledField('emergency', 'detailEmergency', EMERGENCY_LABELS),
  textField('desc', 'detailDesc'),
  {
    key: 'version',
    labelKey: 'detailVersion',
    format: (a) => (num(a.version) === null ? null : `ADS-B v${a.version}`),
    sortValue: (a) => num(a.version),
  },
  labeledField('sourceType', 'detailSourceType', SOURCE_TYPE_LABELS),

  // Altitude / vertical rate.
  {
    key: 'altBaro',
    labelKey: 'detailAltitude',
    format: (a, units) => altitudeValue(a, 'altBaro', units),
    // On-ground sorts below any real positive altitude, on purpose --
    // matches list.js's pre-catalog sortValue exactly.
    sortValue: (a) => (a.onGround ? -1 : num(a.altBaro)),
  },
  altitudeField('altGeom', 'detailAltGeom'),
  rateField('baroRate', 'detailVerticalRate'),
  rateField('geomRate', 'detailGeomRate'),

  // Speed.
  speedField('gs', 'detailGs'),
  speedField('ias', 'detailIas'),
  speedField('tas', 'detailTas'),
  {
    key: 'mach',
    labelKey: 'detailMach',
    format: (a) => (num(a.mach) === null ? null : String(round(a.mach, 2))),
    sortValue: (a) => num(a.mach),
  },

  // Heading / attitude.
  degreesField('track', 'detailTrack'),
  degreesField('magHeading', 'detailMagHeading'),
  degreesField('trueHeading', 'detailTrueHeading'),
  degreesField('roll', 'detailRoll'),
  {
    key: 'trackRate',
    labelKey: 'detailTrackRate',
    format: (a) => (num(a.trackRate) === null ? null : `${round(a.trackRate, 1)}°/s`),
    sortValue: (a) => num(a.trackRate),
  },

  // Autopilot / FMS targets.
  altitudeField('navAltitudeMcp', 'detailNavMcp'),
  altitudeField('navAltitudeFms', 'detailNavFms'),
  degreesField('navHeading', 'detailNavHeading'),
  {
    key: 'navQnh',
    labelKey: 'detailNavQnh',
    format: (a) => (num(a.navQnh) === null ? null : `${round(a.navQnh)} hPa`),
    sortValue: (a) => num(a.navQnh),
  },
  {
    key: 'navModes',
    labelKey: 'detailNavModes',
    format: (a) =>
      Array.isArray(a.navModes) && a.navModes.length > 0
        ? a.navModes.map((m) => NAV_MODE_LABELS[m] ?? m).join(', ')
        : null,
    sortValue: (a) => (Array.isArray(a.navModes) && a.navModes.length > 0 ? a.navModes.length : null),
  },

  // Flags.
  booleanField('military', 'detailMilitary'),
  booleanField('interesting', 'detailInteresting'),
  booleanField('pia', 'detailPia'),
  booleanField('ladd', 'detailLadd'),
  booleanField('alert', 'detailAlert'),
  booleanField('spi', 'detailSpi'),

  // Weather.
  degreesField('wd', 'detailWd'),
  speedField('ws', 'detailWs'),
  {
    key: 'oat',
    labelKey: 'detailOat',
    format: (a) => (num(a.oat) === null ? null : `${round(a.oat)}°C`),
    sortValue: (a) => num(a.oat),
  },
  {
    key: 'tat',
    labelKey: 'detailTat',
    format: (a) => (num(a.tat) === null ? null : `${round(a.tat)}°C`),
    sortValue: (a) => num(a.tat),
  },

  // Signal / reception.
  {
    key: 'rssi',
    labelKey: 'detailRssi',
    format: (a) => (num(a.rssi) === null ? null : `${round(a.rssi, 1)} dBFS`),
    sortValue: (a) => num(a.rssi),
  },
  numberField('messages', 'detailMessages'),
  {
    key: 'seen',
    labelKey: 'detailSeen',
    format: (a) => (num(a.seen) === null ? null : `${round(a.seen, 1)} s`),
    sortValue: (a) => num(a.seen),
  },
  {
    key: 'seenPos',
    labelKey: 'detailSeenPos',
    format: (a) => (num(a.seenPos) === null ? null : `${round(a.seenPos, 1)} s`),
    sortValue: (a) => num(a.seenPos),
  },

  // Data-quality ballast.
  numberField('nic', 'detailNic'),
  numberField('rc', 'detailRc', ' m'),
  numberField('nicBaro', 'detailNicBaro'),
  numberField('nacP', 'detailNacP'),
  numberField('nacV', 'detailNacV'),
  numberField('sil', 'detailSil'),
  labeledField('silType', 'detailSilType', SIL_TYPE_LABELS),
  numberField('gva', 'detailGva'),
  numberField('sda', 'detailSda'),

  // New for the list (not in the aircraft details panel).
  {
    key: 'distance',
    labelKey: 'detailDistance',
    format: (a, units, ctx) => {
      if (!ctx?.home || typeof a.lat !== 'number' || typeof a.lon !== 'number') return null;
      return formatDistance(distanceKm(ctx.home.lat, ctx.home.lon, a.lat, a.lon), units);
    },
    sortValue: (a, ctx) => {
      if (!ctx?.home || typeof a.lat !== 'number' || typeof a.lon !== 'number') return null;
      return distanceKm(ctx.home.lat, ctx.home.lon, a.lat, a.lon);
    },
  },
];

const FIELDS_BY_KEY = new Map(LIST_FIELDS.map((field) => [field.key, field]));

export function getListField(key) {
  return FIELDS_BY_KEY.get(key) ?? null;
}

// Alphabetized by the *current-language* translated label, as requested --
// called at render time (not module load) so a language switch is picked
// up, same reasoning aircraft-details.js documents for staying i18n-free at
// module scope.
export function sortedFieldOptions() {
  return LIST_FIELDS.map((field) => ({ key: field.key, label: t(field.labelKey) })).sort((a, b) =>
    a.label.localeCompare(b.label),
  );
}
