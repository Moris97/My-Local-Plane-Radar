// Production adapter over the 17-icon set (plane-icons.js) and the
// classification chain (icon-classify.js), wired into the live map by
// app.js. Replaced the old 4-shape aircraft-icon.js module (now removed
// from the codebase entirely, 2026-07-30, including /dev/icons' old-vs-new
// comparison row) -- exposes the same function names/shapes that module
// had (createPlaneElement/setPlaneKind/setPlaneHeading/setPlaneColor/
// setPlaneLabel) so app.js's call sites barely had to change -- only the
// import line, plus loadIconTypes() being awaited once at startup and
// refreshMarkerSize() being called when the icon-size setting changes.
import {
  VIEW_BOX, getIconPath, getIconSizeMultiplier, NON_ROTATING_ICON_IDS,
  SPINNING_ROTOR_ICON_IDS, SUGGESTED_SPIN_DURATION_S, getIconRotorPaths,
} from './plane-icons.js';
import { classifyIconKind } from './icon-classify.js';
import { getSettings } from './settings-state.js';

// One rotor group: a soft translucent swept-area disc plus the actual
// blade shape, spinning together (style.css's .mlpr-plane-rotor). Both
// `fill="currentColor"` (no stroke of their own -- see style.css) so they
// still follow setPlaneColor like the rest of the marker. Matches the
// technique worked out and confirmed-good on /dev/icons' "Spinning-rotor
// demo" section (plane-icons.js's SPINNING_ROTOR_ICON_IDS comment) --
// nothing new designed here, just wired into the live marker.
function rotorGroupSvg({ center: [cx, cy], bladePath, suggestedDiscRadius }) {
  return `
    <circle class="mlpr-plane-rotor-disc" cx="${cx}" cy="${cy}" r="${suggestedDiscRadius}" fill="currentColor" opacity="0.22"/>
    <g class="mlpr-plane-rotor" style="--mlpr-rotor-spin-duration: ${SUGGESTED_SPIN_DURATION_S}s"><path d="${bladePath}" fill="currentColor"/></g>`;
}

// Same <g fill+stroke> wrapper technique as the old module (a dark outline
// for contrast against varied map backgrounds) around the new module's
// single <path fill="currentColor">, wound into the wrapper div/label
// structure style.css and app.js both depend on: .mlpr-plane-glow (a
// sibling *before* the svg so it paints behind it, see style.css) and
// .mlpr-plane-label (a sibling *after* it, so it never rotates with the
// icon's own heading transform). For SPINNING_ROTOR_ICON_IDS kinds
// (helicopter/drone), the body is the rotor group(s) plus the kind's
// static (non-blade) path instead of getIconPath()'s single combined
// path -- everything still lives inside the same outer <g>, so
// setPlaneColor's `element.querySelector('g')` (which matches the first
// <g> in document order, i.e. this outer one, even though rotor groups are
// also <g>s nested inside it) keeps working unchanged.
function iconSvg(kind) {
  const rotor = SPINNING_ROTOR_ICON_IDS.has(kind) ? getIconRotorPaths(kind) : null;
  const body = rotor
    ? `${rotor.rotors.map(rotorGroupSvg).join('')}<path d="${rotor.staticPath}"/>`
    : `<path d="${getIconPath(kind)}"/>`;
  return `
<div class="mlpr-plane-glow"></div>
<svg viewBox="${VIEW_BOX}" fill="none" xmlns="http://www.w3.org/2000/svg">
  <g fill="#3ddc84" stroke="#05070a" stroke-width="0.5">
    ${body}
  </g>
</svg>
<div class="mlpr-plane-label"></div>
`;
}

// Per-kind size multiplier (plane-icons.js's ICON_SIZE_MULTIPLIERS -- e.g.
// a widebody reads as 1.25x, a drone as 0.8x) layered on top of the user's
// own base aircraftIconSize slider (Settings -> Aircraft), applied as an
// inline custom-property override on the element itself. This wins over
// the :root-level `--mlpr-plane-size` app.js's own applyIconSize() sets
// (style.css's `.mlpr-plane { width: var(--mlpr-plane-size, 40px) }` reads
// whichever is closer -- an element's own inline value beats an inherited
// one regardless of selector specificity), so each marker still ends up
// sized individually while the root-level value keeps working as a cheap
// fallback for the brief window before any marker exists. Exported so
// app.js can call it per marker when the base setting itself changes (see
// its onSettingsChange handler) -- a kind change already re-triggers it
// internally via setPlaneKind below.
export function refreshMarkerSize(element) {
  const { aircraftIconSize } = getSettings();
  const multiplier = getIconSizeMultiplier(element.dataset.kind);
  element.style.setProperty('--mlpr-plane-size', `${Math.round(aircraftIconSize * multiplier)}px`);
}

export function createPlaneElement(aircraft) {
  const wrapper = document.createElement('div');
  wrapper.className = 'mlpr-plane';
  const { icon } = classifyIconKind(aircraft);
  wrapper.dataset.kind = icon;
  wrapper.innerHTML = iconSvg(icon);
  refreshMarkerSize(wrapper);
  return wrapper;
}

// Type code/category/military can arrive a tick or two after an aircraft
// is first seen (readsb needs a moment to decode them) -- re-classify on
// every update, but only touch the DOM when the resolved icon actually
// changes. Same color/label preservation dance as the old module's
// setPlaneKind, plus a size refresh since the new icon set's per-kind
// multiplier means a kind change can also mean a size change.
export function setPlaneKind(element, aircraft) {
  const { icon } = classifyIconKind(aircraft);
  if (element.dataset.kind === icon) return;
  const color = element.querySelector('g')?.getAttribute('fill');
  const labelText = element.querySelector('.mlpr-plane-label')?.textContent ?? '';
  element.dataset.kind = icon;
  element.innerHTML = iconSvg(icon);
  if (color) element.querySelector('g').setAttribute('fill', color);
  const labelEl = element.querySelector('.mlpr-plane-label');
  if (labelEl) labelEl.textContent = labelText;
  refreshMarkerSize(element);
}

export function setPlaneLabel(element, text) {
  const labelEl = element.querySelector('.mlpr-plane-label');
  if (labelEl) labelEl.textContent = text;
}

// NON_ROTATING_ICON_IDS (balloon/tower/drone -- none of the three have a
// meaningful "nose direction", see plane-icons.js) replaces the old
// module's single hardcoded 'tower' special-case with the real, complete
// set.
export function setPlaneHeading(element, trackDegrees) {
  const svg = element.querySelector('svg');
  if (NON_ROTATING_ICON_IDS.has(element.dataset.kind)) {
    svg.style.transform = '';
    return;
  }
  const heading = typeof trackDegrees === 'number' ? trackDegrees : 0;
  svg.style.transform = `rotate(${heading}deg)`;
}

export function setPlaneColor(element, cssColor) {
  element.querySelector('g').setAttribute('fill', cssColor);
}
