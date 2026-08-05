import { t } from './i18n.js';
import { getInspectedHex, getAircraftByHex, onChange } from './radar-state.js';
import { getSettings, onSettingsChange } from './settings-state.js';
import { buildAircraftDetailTiles, FLAG_VALUE_MARKER, GROUND_MARKER } from './aircraft-details.js';
import { getCachedPhoto, setCachedPhoto } from './photo-cache.js';
import { escapeHtml } from './html-escape.js';

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
  const displayValue = item.value === GROUND_MARKER ? t('onGround') : item.value;
  return `
    <div class="mlpr-detail-tile${fullWidthClass}">
      <div class="mlpr-detail-tile-label">${escapeHtml(t(item.labelKey))}</div>
      <div class="mlpr-detail-tile-value">${escapeHtml(displayValue)}</div>
    </div>`;
}

function renderGroupHtml(items) {
  return `<div class="mlpr-detail-grid">${reorderForPairing(items).map(renderItemHtml).join('')}</div>`;
}

function renderPhoto(photo, photoEl) {
  const link = escapeHtml(photo.link);
  photoEl.innerHTML = `
    <a href="${link}" target="_blank" rel="noopener">
      <img src="${escapeHtml(photo.src)}" alt="" class="mlpr-detail-photo-img">
    </a>
    <p class="mlpr-detail-photo-credit">${escapeHtml(t('photoCredit'))}
      <a href="${link}" target="_blank" rel="noopener">${escapeHtml(photo.photographer || 'Planespotters.net')}</a>
    </p>`;
}

async function loadPhoto(hex, photoEl) {
  if (!hex) return;
  // Opt-out for the fully-offline case -- the project advertises working
  // with no internet at all, so this external call must be disableable.
  if (!getSettings().fetchAircraftPhotos) return;

  const cleanHex = hex.replace(/^~/, '').toLowerCase();

  const cached = getCachedPhoto(cleanHex);
  if (cached.cached) {
    if (cached.photo) renderPhoto(cached.photo, photoEl);
    return;
  }

  try {
    const response = await fetch(`https://api.planespotters.net/pub/photos/hex/${cleanHex}`);
    // Not cached on a non-ok response -- could be transient (rate limit,
    // Planespotters outage), so worth trying again next time rather than
    // remembering a week-long false miss.
    if (!response.ok) return;

    const data = await response.json();
    const photoData = data?.photos?.[0];
    const photo =
      photoData?.thumbnail_large?.src && photoData?.link
        ? { src: photoData.thumbnail_large.src, link: photoData.link, photographer: photoData.photographer }
        : null;

    setCachedPhoto(cleanHex, photo);
    if (photo) renderPhoto(photo, photoEl);
  } catch {
    // No photo available (network error, no CORS in this context) -- fine,
    // the panel just shows tiles without a photo section. Not cached, same
    // reasoning as the non-ok response above.
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

    const { core, extra } = buildAircraftDetailTiles(aircraft, getSettings().units);
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

  const unsubscribeAircraft = onChange(drawTiles);
  const unsubscribeSettings = onSettingsChange(drawTiles);
  return () => {
    unsubscribeAircraft();
    unsubscribeSettings();
  };
}

export function aircraftDetailsPanelTitle() {
  const hex = getInspectedHex();
  const aircraft = hex && getAircraftByHex(hex);
  return aircraft?.flight || aircraft?.hex || t('aircraftDetails');
}
