import { PLANE_ICON_IDS, NON_ROTATING_ICON_IDS, VIEW_BOX, getIconPath, getIconSizeMultiplier } from '/js/plane-icons.js';
import { ICONS as OLD_ICONS } from '/js/aircraft-icon.js';
import { colorForAltitude } from '/js/trail.js';
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

function iconCard({ pathD, sizePx, rotationDeg, label, bg }) {
  const div = document.createElement('div');
  div.className = 'icon-card';
  div.dataset.bg = bg;
  div.innerHTML = `${svgEl(pathD, sizePx, rotationDeg)}<div class="label">${label}</div>`;
  return div;
}

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
    block.appendChild(grid);
    container.appendChild(block);
  }
}

function renderOldVsNew() {
  const container = document.getElementById('old-new-row');
  container.innerHTML = '';
  // Only kinds that exist in both the old 4-shape module and the new set.
  const shared = [
    { newId: 'narrowbody', oldKind: 'passenger' },
    { newId: 'light', oldKind: 'light' },
    { newId: 'helicopter', oldKind: 'helicopter' },
    { newId: 'tower', oldKind: 'tower' },
  ];
  for (const { newId, oldKind } of shared) {
    const pair = document.createElement('div');
    pair.className = 'compare-pair';
    const oldSvg = `<svg viewBox="0 0 24 24" width="40" height="40" fill="none"><g fill="#3ddc84" stroke="#05070a" stroke-width="0.5">${OLD_ICONS[oldKind]}</g></svg>`;
    const newSvg = svgEl(getIconPath(newId), 40, 0);
    pair.innerHTML = `
      <div class="icon-card" data-bg="${currentBg}">${oldSvg}<div class="label">old: ${oldKind}</div></div>
      <div class="arrow">→</div>
      <div class="icon-card" data-bg="${currentBg}">${newSvg}<div class="label">new: ${newId}</div></div>
    `;
    container.appendChild(pair);
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
  renderOldVsNew();
  renderPalette();
  renderClassifyResult();
});
