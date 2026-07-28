// The icon classification chain -- picks a plane-icons.js id for a given
// aircraft. Not wired into the live map yet (see plane-icons.js/TODO.md);
// currently only exercised by /dev/icons and its own tests. Working draft
// as of Stage 1/2 of the icon-set task: the chain/algorithm here is final,
// but data/icon-types.json's table is intentionally small (~25-30 entries)
// until Stage 3 expands it and Stage 4's tools/ script cross-checks it.
//
// Decision order (first match wins):
//   1. typeCode 'TWR' -> 'tower' (not a real aircraft type at all).
//   2. aircraft.military (dbFlags bit 1) + a hit in icon-types.json's
//      'military' table -- military status never *picks* the icon on its
//      own, it only resolves type codes that are genuinely ambiguous
//      between a civilian and a government/military airframe sharing one
//      type designator.
//   3. Our own type table (exact, then longest-matching prefix >= 3 chars).
//   4. The ADS-B `category` field (CATEGORY_MAP below).
//   5. 'unknown'.

const CATEGORY_MAP = {
  A1: 'light',
  A2: 'narrowbody',
  A3: 'narrowbody',
  A4: 'narrowbody',
  A5: 'widebody2',
  A6: 'military_jet',
  A7: 'helicopter',
  B1: 'glider',
  B2: 'balloon',
  B3: 'unknown',
  B4: 'light',
  B6: 'drone',
  B7: 'unknown',
  C1: 'ground_vehicle',
  C2: 'ground_vehicle',
  C3: 'unknown',
};

const MIN_PREFIX_LENGTH = 3;

let iconTypesData = null;
let loadPromise = null;

// Fetched once (like airlines-data.js's client-side counterpart) rather
// than statically imported -- this is plain JSON served as a static file,
// not bundled, and avoids relying on JSON import-assertion support.
export function loadIconTypes(url = '/data/icon-types.json') {
  if (!loadPromise) {
    loadPromise = fetch(url)
      .then((response) => (response.ok ? response.json() : null))
      .catch(() => null)
      .then((data) => {
        iconTypesData = data;
        return data;
      });
  }
  return loadPromise;
}

// Lets tests (and the /dev/icons page, and the tools/ verification script's
// consumers) inject the table directly instead of fetching it.
export function setIconTypes(data) {
  iconTypesData = data;
}

export function getIconTypes() {
  return iconTypesData;
}

function matchOwnTable(typeCode, table) {
  if (!typeCode || !table) return null;
  const exactHit = table.exact?.[typeCode];
  if (exactHit) return { icon: exactHit, stage: 'exact' };
  const prefixes = Object.keys(table.prefix ?? {})
    .filter((prefix) => prefix.length >= MIN_PREFIX_LENGTH)
    .sort((a, b) => b.length - a.length);
  for (const prefix of prefixes) {
    if (typeCode.startsWith(prefix)) return { icon: table.prefix[prefix], stage: 'prefix' };
  }
  return null;
}

// Returns { icon, stage } -- `stage` names which link in the chain decided
// the result ('typeCode-TWR' | 'military-exact' | 'military-prefix' |
// 'exact' | 'prefix' | 'category' | 'unknown'), which is what /dev/icons'
// classification test field shows alongside the icon itself.
export function classifyIconKind(aircraft) {
  if (aircraft?.typeCode === 'TWR') return { icon: 'tower', stage: 'typeCode-TWR' };

  const typeCode = aircraft?.typeCode ? String(aircraft.typeCode).trim().toUpperCase() : null;

  if (aircraft?.military && typeCode && iconTypesData?.military) {
    const hit = matchOwnTable(typeCode, iconTypesData.military);
    if (hit) return { icon: hit.icon, stage: `military-${hit.stage}` };
  }

  if (typeCode && iconTypesData) {
    const hit = matchOwnTable(typeCode, iconTypesData);
    if (hit) return { icon: hit.icon, stage: hit.stage };
  }

  const category = aircraft?.category;
  if (category && CATEGORY_MAP[category]) {
    return { icon: CATEGORY_MAP[category], stage: 'category' };
  }

  return { icon: 'unknown', stage: 'unknown' };
}
