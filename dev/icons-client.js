import {
  PLANE_ICON_IDS, NON_ROTATING_ICON_IDS, VIEW_BOX, getIconPath, getIconSizeMultiplier,
  SPINNING_ROTOR_ICON_IDS, SUGGESTED_SPIN_DURATION_S, getIconRotorPaths,
} from '/js/plane-icons.js';
import { colorForAltitude } from '/js/trail.js';
import { colorForElapsed } from '/js/aircraft-color.js';
import { classifyIconKind, loadIconTypes } from '/js/icon-classify.js';
import { ICON_SIZE_MIN, ICON_SIZE_MAX, ICON_SIZE_DEFAULT } from '/js/settings-state.js';

const ROTATIONS = [0, 45, 137];
const SIZES = [
  { label: 'min', px: ICON_SIZE_MIN },
  { label: 'default', px: ICON_SIZE_DEFAULT },
  { label: 'max', px: ICON_SIZE_MAX },
];

function svgEl(pathD, sizePx, rotationDeg) {
  return `<svg viewBox="${VIEW_BOX}" width="${sizePx}" height="${sizePx}" fill="none" style="transform: rotate(${rotationDeg}deg)">
  <path d="${pathD}" fill="currentColor"/>
</svg>`;
}

function iconCard({ pathD, sizePx, rotationDeg, label, bg, color }) {
  const div = document.createElement('div');
  div.className = 'icon-card';
  div.dataset.bg = bg;
  if (color) div.style.color = color;
  div.innerHTML = `${svgEl(pathD, sizePx, rotationDeg)}<div class="label">${label}</div>`;
  return div;
}

// Same signalLoss-mode endpoints the live map actually fades between
// (aircraft-color.js's colorForElapsed) -- shared by the size-grid's
// green/red reference swatches below and the rotor demo further down, so
// neither can silently drift from what the map really shows or from each
// other.
const SIGNAL_LOSS_FRESH_COLOR = colorForElapsed(0, 0, 1);
const SIGNAL_LOSS_STALE_COLOR = colorForElapsed(1, 0, 1);

let currentBg = 'dark';

function renderSizeGrid() {
  const container = document.getElementById('size-grid');
  container.innerHTML = '';
  for (const id of PLANE_ICON_IDS) {
    const pathD = getIconPath(id);
    const multiplier = getIconSizeMultiplier(id);
    const nonRotating = NON_ROTATING_ICON_IDS.has(id);
    const block = document.createElement('div');
    block.className = 'size-block';
    block.innerHTML = `<h3>${id} (×${multiplier})${nonRotating ? ' — fixed, never rotates with track' : ''}</h3>`;
    const grid = document.createElement('div');
    grid.className = 'icon-grid';
    for (const size of SIZES) {
      const renderedPx = Math.round(size.px * multiplier);
      // Matches setPlaneHeading()'s real behavior: NON_ROTATING_ICON_IDS
      // always render upright, regardless of whatever track/heading value
      // is reported -- showing them "rotated" here would misrepresent how
      // they actually look on the live map.
      for (const rotation of nonRotating ? [0] : ROTATIONS) {
        grid.appendChild(iconCard({
          pathD,
          sizePx: renderedPx,
          rotationDeg: rotation,
          label: nonRotating ? `${size.label} (${renderedPx}px) · fixed` : `${size.label} (${renderedPx}px) · ${rotation}°`,
          bg: currentBg,
        }));
      }
    }
    // A flat, unscaled 40px reference pair (ignoring this kind's own
    // ICON_SIZE_MULTIPLIER, unlike every card above) in the two signal-loss
    // gradient endpoints, so color at a common size is comparable across
    // every icon kind regardless of how big/small that kind normally
    // renders relative to the others.
    grid.appendChild(iconCard({
      pathD, sizePx: 40, rotationDeg: 0, label: '40px · fresh', bg: currentBg, color: SIGNAL_LOSS_FRESH_COLOR,
    }));
    grid.appendChild(iconCard({
      pathD, sizePx: 40, rotationDeg: 0, label: '40px · stale', bg: currentBg, color: SIGNAL_LOSS_STALE_COLOR,
    }));
    block.appendChild(grid);
    container.appendChild(block);
  }
}

const PALETTE_ALTITUDES_FT = [0, 5000, 10000, 15000, 17500, 21000, 24000, 27000, 30250, 33000, 36000, 40000];

function renderPalette() {
  const container = document.getElementById('palette-strip');
  container.innerHTML = '';
  const pathD = getIconPath('narrowbody');
  for (const altFt of PALETTE_ALTITUDES_FT) {
    const color = colorForAltitude(altFt);
    const cell = document.createElement('div');
    cell.className = 'palette-cell';
    cell.innerHTML = `
      <div class="icon-card" data-bg="${currentBg}" style="color:${color}">${svgEl(pathD, 32, 0)}</div>
      <div class="alt-label">${altFt.toLocaleString()} ft</div>
    `;
    container.appendChild(cell);
  }
}

function rotorDemoSvg(kind, sizePx) {
  const { staticPath, rotors } = getIconRotorPaths(kind);
  // The CSS ".rotor" class rotates around `transform-box: fill-box` +
  // `transform-origin: center` -- i.e. the bounding box of each <g>'s own
  // blade path, which is exactly `center` by construction (both
  // helicopterBladesPath and droneBladeAt() are built symmetric around
  // their rotor center), so no per-instance inline transform-origin is
  // needed here.
  const rotorEls = rotors.map(({ center: [cx, cy], bladePath, suggestedDiscRadius }) => `
    <circle class="blur-disc" cx="${cx}" cy="${cy}" r="${suggestedDiscRadius}" fill="currentColor" opacity="0.22"></circle>
    <g class="rotor"><path d="${bladePath}" fill="currentColor"/></g>
  `).join('');
  return `<svg viewBox="${VIEW_BOX}" width="${sizePx}" height="${sizePx}" fill="none">
    ${rotorEls}
    <path d="${staticPath}" fill="currentColor"/>
  </svg>`;
}

const ROTOR_DEMO_COLORS = [
  { label: 'default', color: null },
  { label: 'fresh (signal-loss green)', color: SIGNAL_LOSS_FRESH_COLOR },
  { label: 'stale (signal-loss red)', color: SIGNAL_LOSS_STALE_COLOR },
];

function renderRotorDemo() {
  const container = document.getElementById('rotor-demo-row');
  container.innerHTML = '';
  for (const kind of SPINNING_ROTOR_ICON_IDS) {
    for (const { label, color } of ROTOR_DEMO_COLORS) {
      const card = document.createElement('div');
      card.className = 'icon-card rotor-demo-card';
      card.dataset.bg = currentBg;
      card.style.setProperty('--spin-duration', `${SUGGESTED_SPIN_DURATION_S}s`);
      if (color) card.style.color = color;
      card.innerHTML = `${rotorDemoSvg(kind, 96)}<div class="label">${kind} · ${label}</div>`;
      container.appendChild(card);
    }
  }
}

function applyBg(bg) {
  currentBg = bg;
  for (const el of document.querySelectorAll('.icon-card')) el.dataset.bg = bg;
  for (const button of document.querySelectorAll('#bg-toggle button')) {
    button.classList.toggle('active', button.dataset.bg === bg);
  }
}

document.getElementById('bg-toggle').addEventListener('click', (event) => {
  const bg = event.target.dataset.bg;
  if (bg) applyBg(bg);
});

function renderClassifyResult() {
  const typeCode = document.getElementById('in-type').value.trim() || undefined;
  const category = document.getElementById('in-category').value.trim() || undefined;
  const military = document.getElementById('in-military').checked;
  const { icon, stage } = classifyIconKind({ typeCode, category, military });
  const container = document.getElementById('classify-result');
  container.innerHTML = `
    <div class="icon-card" data-bg="${currentBg}">${svgEl(getIconPath(icon), 48, 0)}<div class="label">${icon}</div></div>
    <div class="stage">chain stage: ${stage}</div>
  `;
}

for (const id of ['in-type', 'in-category', 'in-military']) {
  document.getElementById(id).addEventListener('input', renderClassifyResult);
}

loadIconTypes().finally(() => {
  renderSizeGrid();
  renderPalette();
  renderRotorDemo();
  renderClassifyResult();
});
