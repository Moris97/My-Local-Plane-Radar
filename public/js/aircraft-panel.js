import { t } from './i18n.js';
import { getInspectedHex, getAircraftByHex, onChange } from './radar-state.js';
import { buildAircraftDetailTiles, FLAG_VALUE_MARKER } from './aircraft-details.js';

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// A tile with a pairId is meant to sit side by side with its partner (e.g.
// flight/registration). If the partner is missing for this aircraft, plain
// array order would let a later, unrelated tile drift into that slot
// instead -- so pairs are matched up explicitly here and anything left
// without a partner is promoted to a full-width row instead of leaving a
// stray half-empty cell.
function reorderForPairing(items) {
  const result = [];
  const consumed = new Set();

  for (let i = 0; i < items.length; i++) {
    if (consumed.has(i)) continue;
    const item = items[i];

    if (item.chips || !item.pairId) {
      result.push(item);
      consumed.add(i);
      continue;
    }

    const partnerIndex = items.findIndex((other, j) => j > i && !consumed.has(j) && other.pairId === item.pairId);
    if (partnerIndex === -1) {
      result.push({ ...item, fullWidth: true });
      consumed.add(i);
      continue;
    }

    result.push(item, items[partnerIndex]);
    consumed.add(i);
    consumed.add(partnerIndex);
  }

  return result;
}

function renderItemHtml(item) {
  if (item.chips) {
    return `
      <div class="mlpr-detail-cluster">
        <div class="mlpr-detail-cluster-label">${escapeHtml(t(item.labelKey))}</div>
        <div class="mlpr-detail-cluster-chips">
          ${item.chips
            .map(
              (chip) =>
                `<span class="mlpr-detail-chip"><b>${escapeHtml(t(chip.labelKey))}</b> ${escapeHtml(chip.value)}</span>`,
            )
            .join('')}
        </div>
      </div>`;
  }

  const fullWidthClass = item.fullWidth ? ' mlpr-detail-tile-full' : '';

  if (item.value === FLAG_VALUE_MARKER) {
    return `<div class="mlpr-detail-tile mlpr-detail-flag${fullWidthClass}">${escapeHtml(t(item.labelKey))}</div>`;
  }
  return `
    <div class="mlpr-detail-tile${fullWidthClass}">
      <div class="mlpr-detail-tile-label">${escapeHtml(t(item.labelKey))}</div>
      <div class="mlpr-detail-tile-value">${escapeHtml(item.value)}</div>
    </div>`;
}

function renderGroupHtml(items) {
  return `<div class="mlpr-detail-grid">${reorderForPairing(items).map(renderItemHtml).join('')}</div>`;
}

async function loadPhoto(hex, photoEl) {
  if (!hex) return;
  try {
    const cleanHex = hex.replace(/^~/, '').toLowerCase();
    const response = await fetch(`https://api.planespotters.net/pub/photos/hex/${cleanHex}`);
    if (!response.ok) return;
    const data = await response.json();
    const photo = data?.photos?.[0];
    if (!photo?.thumbnail_large?.src || !photo?.link) return;

    const link = escapeHtml(photo.link);
    photoEl.innerHTML = `
      <a href="${link}" target="_blank" rel="noopener">
        <img src="${escapeHtml(photo.thumbnail_large.src)}" alt="" class="mlpr-detail-photo-img">
      </a>
      <p class="mlpr-detail-photo-credit">${escapeHtml(t('photoCredit'))}
        <a href="${link}" target="_blank" rel="noopener">${escapeHtml(photo.photographer || 'Planespotters.net')}</a>
      </p>`;
  } catch {
    // No photo available (network error, no CORS in this context, nothing
    // found) -- fine, the panel just shows tiles without a photo section.
  }
}

export function renderAircraftDetailsPanel(container) {
  const hex = getInspectedHex();

  container.innerHTML = `
    <div id="mlpr-detail-photo"></div>
    <div id="mlpr-detail-tiles"></div>
  `;

  const photoEl = container.querySelector('#mlpr-detail-photo');
  const tilesEl = container.querySelector('#mlpr-detail-tiles');

  let expanded = false;

  function drawTiles() {
    const aircraft = hex && getAircraftByHex(hex);
    if (!aircraft) {
      tilesEl.innerHTML = `<p class="mlpr-empty">${escapeHtml(t('aircraftGone'))}</p>`;
      return;
    }

    const { core, extra } = buildAircraftDetailTiles(aircraft);
    let html = renderGroupHtml(core);
    if (extra.length > 0) {
      html += `
        <button type="button" id="mlpr-detail-expand" class="mlpr-detail-expand">
          ${escapeHtml(expanded ? t('collapseDetails') : t('expandDetails'))}
        </button>
        <div id="mlpr-detail-extra" style="${expanded ? '' : 'display:none'}">${renderGroupHtml(extra)}</div>`;
    }
    tilesEl.innerHTML = html;

    tilesEl.querySelector('#mlpr-detail-expand')?.addEventListener('click', () => {
      expanded = !expanded;
      drawTiles();
    });
  }

  drawTiles();
  loadPhoto(hex, photoEl);

  return onChange(drawTiles);
}

export function aircraftDetailsPanelTitle() {
  const hex = getInspectedHex();
  const aircraft = hex && getAircraftByHex(hex);
  return aircraft?.flight || aircraft?.hex || t('aircraftDetails');
}
