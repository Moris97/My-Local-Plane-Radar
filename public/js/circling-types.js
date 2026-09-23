// Aircraft-type filter for the circling alert -- the table in Settings ->
// Notifications -> "Circling aircraft alert" (one row per class, one
// checkbox per military/non-military column). Shared by the browser (to
// render the table) and the server (rules.js, to decide whose circling
// notifies), so the two can never disagree about which icon kind belongs
// to which row. Pure, no DOM, no fetch.
//
// The rows are built on icon-classify.js's classifyIconKind rather than on
// the raw ADS-B `category` field: category has no notion of "cargo" at all
// (a C-130 and an ATR 72 are both just A2/A3), and the icon table is the
// one place this project already maps type codes to kinds of aircraft.
// Category still feeds in as that chain's own fallback link, so an
// aircraft with no type code still lands in a sensible row.

export const CIRCLING_TYPE_CLASSES = [
  'narrowbody', 'widebody', 'bizjet', 'cargo', 'helicopter', 'light', 'fighter', 'glider', 'other',
];

const ICON_TO_CLASS = {
  narrowbody: 'narrowbody',
  widebody2: 'widebody',
  widebody3: 'widebody',
  widebody4: 'widebody',
  special: 'widebody',
  bizjet: 'bizjet',
  cargo_turboprop: 'cargo',
  cargo_jet: 'cargo',
  helicopter: 'helicopter',
  light: 'light',
  military_jet: 'fighter',
  glider: 'glider',
};

// Everything not listed above (balloon, drone, ground vehicle, tower,
// unknown) shares one "other / unknown" row -- none of them is common
// enough, or distinct enough in what circling would mean, to earn its own.
export function circlingClassForIcon(iconKind) {
  return ICON_TO_CLASS[iconKind] ?? 'other';
}

// Defaults reproduce the fixed allowlist this table replaced (v2.2.3):
// any military aircraft, plus civilian airliners, business jets and
// helicopters. Cargo joins them -- it was A2-A5 by category before, i.e.
// already included. Light aircraft (routine circuit training), civilian
// high-performance/aerobatic (the old A6 exclusion), gliders (thermalling)
// and unknowns stay off.
const DEFAULT_CIVIL_CLASSES = new Set(['narrowbody', 'widebody', 'bizjet', 'cargo', 'helicopter']);

export const DEFAULT_CIRCLING_TYPES = Object.fromEntries(
  CIRCLING_TYPE_CLASSES.map((cls) => [cls, { military: true, civil: DEFAULT_CIVIL_CLASSES.has(cls) }]),
);

// Fills any class/column missing from a stored value with its default --
// a class added by a later version, or a partial PATCH, never reads as
// "unchecked" by accident.
export function resolveCirclingTypes(stored) {
  const result = {};
  for (const cls of CIRCLING_TYPE_CLASSES) {
    result[cls] = { ...DEFAULT_CIRCLING_TYPES[cls], ...(stored?.[cls] ?? {}) };
  }
  return result;
}

export function isCirclingTypeEnabled(circlingTypes, iconKind, military) {
  const row = resolveCirclingTypes(circlingTypes)[circlingClassForIcon(iconKind)];
  return military ? row.military : row.civil;
}
