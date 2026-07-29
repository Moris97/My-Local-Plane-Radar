import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyIconKind, setIconTypes } from './icon-classify.js';
import { PLANE_ICON_IDS } from './plane-icons.js';

// The real shipped table -- read directly rather than through
// loadIconTypes()'s fetch() (no server running under plain `node --test`),
// same reasoning as server/src/airlines-data.js reading its JSON off disk.
const dataPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'icon-types.json');
const iconTypes = JSON.parse(readFileSync(dataPath, 'utf8'));
setIconTypes(iconTypes);

const MIN_PREFIX_LENGTH = 3;

test('every icon-types.json exact entry maps to a real icon id', () => {
  for (const [code, icon] of Object.entries(iconTypes.exact)) {
    assert.ok(PLANE_ICON_IDS.includes(icon), `${code} -> unknown icon '${icon}'`);
  }
});

test('every icon-types.json prefix entry maps to a real icon id and is >=3 chars', () => {
  for (const [prefix, icon] of Object.entries(iconTypes.prefix)) {
    assert.ok(PLANE_ICON_IDS.includes(icon), `${prefix} -> unknown icon '${icon}'`);
    assert.ok(prefix.length >= MIN_PREFIX_LENGTH, `prefix '${prefix}' is shorter than ${MIN_PREFIX_LENGTH} chars`);
  }
});

test('every icon-types.json military.exact entry maps to a real icon id', () => {
  for (const [code, icon] of Object.entries(iconTypes.military.exact)) {
    assert.ok(PLANE_ICON_IDS.includes(icon), `${code} -> unknown icon '${icon}'`);
  }
});

// Spot-checks against the real table for each link of the classification
// chain -- not exhaustive (that's what the full table + Stage 4's tooling
// is for), just confirms the chain still resolves real, common entries
// correctly after the Stage 3 expansion.
test('classifyIconKind resolves real spot-check entries via the real table', () => {
  assert.equal(classifyIconKind({ typeCode: 'TWR' }).icon, 'tower');
  assert.equal(classifyIconKind({ typeCode: 'A20N' }).icon, 'narrowbody'); // A320neo, Stage 3 addition
  assert.equal(classifyIconKind({ typeCode: 'B38M' }).icon, 'narrowbody'); // 737 MAX 8, Stage 3 addition
  assert.equal(classifyIconKind({ typeCode: 'EC35' }).icon, 'helicopter'); // Stage 3's first helicopter entries
  assert.equal(classifyIconKind({ typeCode: 'C130' }).icon, 'cargo_turboprop');
  assert.equal(classifyIconKind({ typeCode: 'F16' }).icon, 'military_jet');
  assert.equal(classifyIconKind({ typeCode: 'C172' }).icon, 'light');
  // A332 with no military flag: not in the regular table directly, but
  // still resolves via the existing 'A33' prefix (A330 family -> widebody2).
  assert.equal(classifyIconKind({ typeCode: 'A332' }).icon, 'widebody2');
  // Same type code, military flag set: the military table's exact entry
  // wins instead (tanker/AWACS-derivative sharing the civilian code).
  assert.equal(classifyIconKind({ typeCode: 'A332', military: true }).icon, 'special');
  // Unknown type code with no category falls through to 'unknown'.
  assert.equal(classifyIconKind({ typeCode: 'ZZZZ' }).icon, 'unknown');
});
