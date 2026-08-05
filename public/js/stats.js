import { t } from './i18n.js';
import { getLiveStats, getLiveAircraft, onChange } from './radar-state.js';
import { getSettings, onSettingsChange } from './settings-state.js';
import {
  renderLineChartSvg,
  renderAreaChartSvg,
  renderBarChartSvg,
  renderDoughnutSvg,
  renderRoseChartSvg,
  mergeRoseSectors,
  doughnutSlices,
  formatBucketLabel,
  defaultFormatValue,
  DOUGHNUT_COLORS,
} from './chart.js';
import { formatDistance, formatAltitude, formatSpeed } from './units.js';
import { findNearestFarthest } from './geo.js';
import { rowsToCsv } from './csv.js';
import { debounce, SEARCH_DEBOUNCE_MS } from './debounce.js';
import { escapeHtml } from './html-escape.js';

const HISTORY_REFRESH_MS = 20000;
const TREND_TOP_N = 5;
// The directional coverage rose is rendered from the server's full 180-sector
// resolution (server/src/antenna-stats.js's SECTOR_COUNT), which at 2° per
// sector is dozens of slivers too thin to read as individual petals -- see
// chart.js's mergeRoseSectors. Went 3 -> 12 (30° per wedge, one per clock
// position) on request once hover made the exact value discoverable either
// way -- 12 gives a genuinely more legible compass shape than 3 without
// going back to the original illegible slivers.
const ROSE_DISPLAY_SECTORS = 12;

const RANGES = ['24h', '7d', '31d', '1y', 'all'];
const RANGE_LABEL_KEYS = {
  '24h': 'statsRange24h',
  '7d': 'statsRange7d',
  '31d': 'statsRange31d',
  '1y': 'statsRange1y',
  all: 'statsRangeAll',
};

// Persisted directly (not via settings-state.js) -- this is remembered UI
// state ("what was I last looking at"), not a user-facing Settings option,
// so it doesn't belong in that module's schema alongside things that
// actually appear as Settings controls.
const RANGE_STORAGE_KEY = 'mlpr-stats-range';

function loadPersistedRange() {
  try {
    const stored = localStorage.getItem(RANGE_STORAGE_KEY);
    return RANGES.includes(stored) ? stored : 'all';
  } catch {
    return 'all';
  }
}

function persistRange(range) {
  try {
    localStorage.setItem(RANGE_STORAGE_KEY, range);
  } catch {
    // Private browsing / storage disabled -- fine, just won't persist.
  }
}

let currentRange = loadPersistedRange();

// Which view (doughnut or line-over-time) each of the two "most common"
// charts is currently showing. Deliberately module-scoped like currentRange
// above rather than reset inside renderStatsPanel -- closing and reopening
// the Stats panel keeps whichever view was picked; only a full page reload
// resets it to the doughnut default. Not persisted to localStorage though
// (unlike currentRange): a passing choice of "let me see the trend" doesn't
// need to survive a reload the way "which time range am I looking at" does.
const chartView = { topType: 'doughnut', topAirline: 'doughnut' };

let airlinesCache = null;

// Caches the last-fetched /api/stats/types or /api/stats/airlines counts
// per chart kind, keyed by the range they were fetched for -- the
// doughnut<->line view toggle used to re-fetch from scratch on every click
// even though the range hadn't changed and the same counts were just
// fetched moments ago for the other view. { range, counts } | null per kind.
const topChartCountsCache = { topType: null, topAirline: null };

async function fetchTopChartCounts(kind, countsUrl, range, forceRefresh) {
  const cached = topChartCountsCache[kind];
  if (!forceRefresh && cached && cached.range === range) {
    return cached.counts;
  }
  const counts = await fetchJson(countsUrl, []);
  topChartCountsCache[kind] = { range, counts };
  return counts;
}

async function fetchJson(url, fallback) {
  try {
    const response = await fetch(url);
    if (!response.ok) return fallback;
    return await response.json();
  } catch {
    return fallback;
  }
}

async function getAirlinesMap() {
  if (airlinesCache) return airlinesCache;
  const raw = await fetchJson('/api/airlines', {});
  airlinesCache = new Map(Object.entries(raw));
  return airlinesCache;
}

function legendItemHtml(color, label, value) {
  return `<span class="mlpr-chart-legend-item"><span class="mlpr-chart-legend-swatch" style="background:${color}"></span>${escapeHtml(label)}${value != null ? `: ${escapeHtml(value)}` : ''}</span>`;
}

// Doughnut legends get their own row shape (label left, value + percent
// right, laid out by the .mlpr-stat-chart-doughnut .mlpr-chart-legend grid
// in style.css) rather than reusing legendItemHtml's plain chip -- a ranked
// "which slice is which, and how big a share" list reads better than a
// loose row of "label: value" chips once there's a percentage to show too.
function doughnutLegendItemHtml(color, label, value, percent, i) {
  return `<span class="mlpr-chart-legend-item" data-i="${i}"><span class="mlpr-chart-legend-swatch" style="background:${color}"></span><span class="mlpr-chart-legend-item-label">${escapeHtml(label)}</span><span class="mlpr-chart-legend-item-value">${escapeHtml(String(value))}</span><span class="mlpr-chart-legend-item-percent">${percent}%</span></span>`;
}

// Hover tooltip shared by every bucketed chart (line/area/bar): shows
// exactly which bucket the pointer is over and each series' precise value
// there, on request (2026-08-03) -- until now a chart's only readout was
// the Y-axis's max/mid/zero labels and whatever the legend showed for the
// *last* bucket, with nothing in between.
//
// Deliberately does not recompute "which bucket is the pointer over" from
// coordinates -- that geometry already exists once, in chart.js's own
// pointHitRegionsSvg/bar hit regions, as real (invisible) DOM elements
// carrying a `data-i` bucket index. This only reads that index back off
// whatever element a pointer event landed on, the same "hit-test and
// drawing must share one source of truth" reasoning the trigger-area
// editor's rectangle bounds already document -- two independently computed
// x-to-bucket mappings could silently disagree, one shared one can't.
//
// `series` here also carries a `label` per entry (added at each call site
// alongside `key`/`color`) purely for this tooltip's row text -- the
// existing legend-building calls elsewhere are untouched and keep writing
// their own labels by hand.
function wireChartTooltip(wrapEl, buckets, series, { formatValue = defaultFormatValue, formatBucket = formatBucketLabel } = {}) {
  if (!wrapEl || buckets.length === 0) return;

  const tooltip = document.createElement('div');
  tooltip.className = 'mlpr-chart-tooltip';
  wrapEl.appendChild(tooltip);

  function setActiveIndex(index) {
    for (const el of wrapEl.querySelectorAll('.active')) el.classList.remove('active');
    if (index == null) return;
    for (const el of wrapEl.querySelectorAll(`[data-i="${index}"]`)) el.classList.add('active');
  }

  function positionNear(clientX, clientY) {
    const wrapRect = wrapEl.getBoundingClientRect();
    const left = Math.max(4, Math.min(clientX - wrapRect.left + 12, wrapRect.width - tooltip.offsetWidth - 4));
    const top = Math.max(4, clientY - wrapRect.top - tooltip.offsetHeight - 12);
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
  }

  function showBucket(index, clientX, clientY) {
    const bucket = buckets[index];
    if (!bucket) return;
    const rows = series
      .map(
        (s) =>
          `<div class="mlpr-chart-tooltip-row"><span class="mlpr-chart-tooltip-swatch" style="background:${s.color}"></span>${escapeHtml(s.label ?? s.key)}<span class="mlpr-chart-tooltip-value">${escapeHtml(formatValue(bucket[s.key] ?? 0))}</span></div>`,
      )
      .join('');
    tooltip.innerHTML = `<div class="mlpr-chart-tooltip-date">${escapeHtml(formatBucket(bucket.bucket))}</div>${rows}`;
    tooltip.classList.add('visible');
    setActiveIndex(index);
    positionNear(clientX, clientY);
  }

  function onPointerActive(event) {
    const hit = event.target.closest('.mlpr-chart-hit');
    if (!hit) return;
    showBucket(Number(hit.dataset.i), event.clientX, event.clientY);
  }

  function onPointerLeave() {
    tooltip.classList.remove('visible');
    setActiveIndex(null);
  }

  // pointerdown too, not just pointermove: on touch there's no hover state,
  // so a tap needs to raise the tooltip immediately rather than only ever
  // updating once a drag is already under way.
  wrapEl.addEventListener('pointerdown', onPointerActive);
  wrapEl.addEventListener('pointermove', onPointerActive);
  wrapEl.addEventListener('pointerleave', onPointerLeave);
}

// Doughnut equivalent of wireChartTooltip above -- same shared-tooltip-
// element/positioning shape, but keyed off chart.js's per-slice
// .mlpr-doughnut-slice[data-i] circles instead of the bucketed charts'
// invisible .mlpr-chart-hit rects (a doughnut needs no separate hit-region
// geometry: each slice is stroke-only, so the browser's own hit-testing
// already resolves a pointer event to just the painted arc). Also
// highlights the matching legend row (data-i set by doughnutLegendItemHtml)
// so hovering either the ring or the legend cross-highlights the other.
function wireDoughnutTooltip(wrapEl, legendEl, slices) {
  if (!wrapEl || slices.length === 0) return;
  const total = slices.reduce((sum, s) => sum + s.value, 0) || 1;

  const tooltip = document.createElement('div');
  tooltip.className = 'mlpr-chart-tooltip';
  wrapEl.appendChild(tooltip);

  function setActiveIndex(index) {
    for (const el of wrapEl.querySelectorAll('.active')) el.classList.remove('active');
    if (legendEl) for (const el of legendEl.querySelectorAll('.active')) el.classList.remove('active');
    if (index == null) return;
    wrapEl.querySelector(`[data-i="${index}"]`)?.classList.add('active');
    legendEl?.querySelector(`[data-i="${index}"]`)?.classList.add('active');
  }

  function positionNear(clientX, clientY) {
    const wrapRect = wrapEl.getBoundingClientRect();
    const left = Math.max(4, Math.min(clientX - wrapRect.left + 12, wrapRect.width - tooltip.offsetWidth - 4));
    const top = Math.max(4, clientY - wrapRect.top - tooltip.offsetHeight - 12);
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
  }

  function showSlice(index, clientX, clientY) {
    const slice = slices[index];
    if (!slice) return;
    const percent = Math.round((slice.value / total) * 100);
    tooltip.innerHTML = `<div class="mlpr-chart-tooltip-date">${escapeHtml(slice.label)}</div><div class="mlpr-chart-tooltip-row">${escapeHtml(String(slice.value))} (${percent}%)</div>`;
    tooltip.classList.add('visible');
    setActiveIndex(index);
    positionNear(clientX, clientY);
  }

  function onPointerActive(event) {
    const hit = event.target.closest('.mlpr-doughnut-slice');
    if (!hit) return;
    showSlice(Number(hit.dataset.i), event.clientX, event.clientY);
  }

  function onPointerLeave() {
    tooltip.classList.remove('visible');
    setActiveIndex(null);
  }

  wrapEl.addEventListener('pointerdown', onPointerActive);
  wrapEl.addEventListener('pointermove', onPointerActive);
  wrapEl.addEventListener('pointerleave', onPointerLeave);
}

// Rose-chart equivalent of wireChartTooltip/wireDoughnutTooltip above --
// keyed off chart.js's per-wedge .mlpr-rose-hit[data-i] hit regions, which
// (unlike the visible .mlpr-rose-petal paths) always cover their full
// wedge regardless of value, so a direction with nothing recorded yet is
// still hoverable and honestly reports its value instead of being a silent
// dead zone next to responsive ones.
function wireRoseTooltip(wrapEl, items, { formatValue = defaultFormatValue } = {}) {
  if (!wrapEl || items.length === 0) return;
  const sectorAngle = 360 / items.length;

  const tooltip = document.createElement('div');
  tooltip.className = 'mlpr-chart-tooltip';
  wrapEl.appendChild(tooltip);

  function setActiveIndex(index) {
    for (const el of wrapEl.querySelectorAll('.active')) el.classList.remove('active');
    if (index == null) return;
    wrapEl.querySelector(`.mlpr-rose-petal[data-i="${index}"]`)?.classList.add('active');
  }

  function positionNear(clientX, clientY) {
    const wrapRect = wrapEl.getBoundingClientRect();
    const left = Math.max(4, Math.min(clientX - wrapRect.left + 12, wrapRect.width - tooltip.offsetWidth - 4));
    const top = Math.max(4, clientY - wrapRect.top - tooltip.offsetHeight - 12);
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
  }

  function showSector(index, clientX, clientY) {
    const item = items[index];
    if (!item) return;
    const start = Math.round(index * sectorAngle);
    const end = Math.round((index + 1) * sectorAngle);
    tooltip.innerHTML = `<div class="mlpr-chart-tooltip-date">${start}°–${end}°</div><div class="mlpr-chart-tooltip-row">${escapeHtml(formatValue(item.value))}</div>`;
    tooltip.classList.add('visible');
    setActiveIndex(index);
    positionNear(clientX, clientY);
  }

  function onPointerActive(event) {
    const hit = event.target.closest('.mlpr-rose-hit');
    if (!hit) return;
    showSector(Number(hit.dataset.i), event.clientX, event.clientY);
  }

  function onPointerLeave() {
    tooltip.classList.remove('visible');
    setActiveIndex(null);
  }

  wrapEl.addEventListener('pointerdown', onPointerActive);
  wrapEl.addEventListener('pointermove', onPointerActive);
  wrapEl.addEventListener('pointerleave', onPointerLeave);
}

// hint (optional): a translated explanation shown in the same
// .mlpr-info-icon hover/focus tooltip settings.js already uses throughout
// Settings -- reused here rather than cramming the explanation into the
// tile label itself, e.g. "Aircraft tracked" needing to say *why* it can
// read lower than "Aircraft seen" (the ~3s/second-look confirmation gate).
function tileHtml(label, value, hint) {
  // Matches settings.js's existing .mlpr-info-icon call sites: hint is
  // always a static, developer-authored t() string, never user data, so
  // it's interpolated unescaped there too -- not a real HTML-injection
  // path, just consistent with how every other info-icon tooltip in the
  // app is already built.
  const hintHtml = hint ? ` <button type="button" class="mlpr-info-icon">i<span class="mlpr-tooltip">${hint}</span></button>` : '';
  return `<div class="mlpr-tile"><div class="mlpr-tile-label">${escapeHtml(label)}${hintHtml}</div><div class="mlpr-tile-value">${escapeHtml(value)}</div></div>`;
}

// entry: an aircraft object (from geo.js's findNearestFarthest) with an
// extra distanceKm field, or null (no home configured / no positioned
// aircraft). emptyMessage distinguishes those two null cases for the
// reader instead of a single generic "no data".
function aircraftTileHtml(label, entry, units, emptyMessage) {
  if (!entry) {
    return `<div class="mlpr-aircraft-tile"><div class="mlpr-tile-label">${escapeHtml(label)}</div><p class="mlpr-empty">${escapeHtml(emptyMessage)}</p></div>`;
  }
  const title = entry.flight?.trim() || entry.hex;
  const subParts = [entry.registration, entry.typeCode].filter(Boolean);
  const altitude = entry.onGround ? t('onGround') : formatAltitude(entry.altBaro, units);
  const speed = formatSpeed(entry.gs, units);
  const distance = formatDistance(entry.distanceKm, units);
  const chips = [altitude, speed, distance].filter(Boolean);

  return `
    <div class="mlpr-aircraft-tile">
      <div class="mlpr-tile-label">${escapeHtml(label)}</div>
      <div class="mlpr-aircraft-tile-title">${escapeHtml(title)}</div>
      ${subParts.length ? `<div class="mlpr-aircraft-tile-sub">${escapeHtml(subParts.join(' · '))}</div>` : ''}
      <div class="mlpr-aircraft-tile-stats">${chips.map((c) => `<span>${escapeHtml(c)}</span>`).join('')}</div>
    </div>`;
}

export function renderStatsPanel(container) {
  container.innerHTML = `
    <section class="mlpr-stats-section">
      <h3 class="mlpr-stats-section-title">${t('statsNow')}</h3>
      <div class="mlpr-tiles-grid" id="mlpr-now-tiles"></div>
      <div class="mlpr-tiles-grid mlpr-tiles-grid-wide" id="mlpr-now-aircraft-tiles"></div>
    </section>

    <section class="mlpr-stats-section mlpr-stats-section-divider">
      <div class="mlpr-stats-range" id="mlpr-stats-range"></div>

      <div class="mlpr-stats-subsection">
        <h3 class="mlpr-stats-section-title" id="mlpr-summary-title"></h3>
        <div class="mlpr-tiles-grid" id="mlpr-summary-tiles"></div>
        <div class="mlpr-stats-grid">
          <section class="mlpr-stat-chart mlpr-stat-chart-doughnut">
            <div class="mlpr-chart-header">
              <p class="mlpr-chart-label">${t('chartTopType')}</p>
              <div class="mlpr-chart-view-toggle" data-chart="topType">
                <button type="button" class="mlpr-range-btn active" data-view="doughnut">${t('chartViewDoughnut')}</button>
                <button type="button" class="mlpr-range-btn" data-view="line">${t('chartViewLine')}</button>
              </div>
            </div>
            <div id="mlpr-chart-top-type"></div>
            <div class="mlpr-chart-legend" id="mlpr-legend-top-type"></div>
          </section>

          <section class="mlpr-stat-chart mlpr-stat-chart-doughnut">
            <div class="mlpr-chart-header">
              <p class="mlpr-chart-label">${t('chartTopAirline')}</p>
              <div class="mlpr-chart-view-toggle" data-chart="topAirline">
                <button type="button" class="mlpr-range-btn active" data-view="doughnut">${t('chartViewDoughnut')}</button>
                <button type="button" class="mlpr-range-btn" data-view="line">${t('chartViewLine')}</button>
              </div>
            </div>
            <div id="mlpr-chart-top-airline"></div>
            <div class="mlpr-chart-legend" id="mlpr-legend-top-airline"></div>
            <p class="mlpr-chart-attribution">Airline data: <a href="https://openflights.org/data.php" target="_blank" rel="noopener">OpenFlights</a> (ODbL)</p>
          </section>
        </div>
      </div>

      <div class="mlpr-stats-subsection">
        <h3 class="mlpr-stats-section-title">${t('statsOverTime')}</h3>
        <div class="mlpr-stats-grid">
          <section class="mlpr-stat-chart">
            <p class="mlpr-chart-label">${t('chartAircraftCount')}</p>
            <div id="mlpr-chart-aircraft-count"></div>
            <div class="mlpr-chart-legend" id="mlpr-legend-aircraft-count"></div>
          </section>

          <section class="mlpr-stat-chart">
            <p class="mlpr-chart-label">${t('chartPosition')}</p>
            <div id="mlpr-chart-position"></div>
            <div class="mlpr-chart-legend" id="mlpr-legend-position"></div>
          </section>

          <section class="mlpr-stat-chart">
            <p class="mlpr-chart-label">${t('chartNewRegistrations')}</p>
            <div id="mlpr-chart-new-registrations"></div>
          </section>
        </div>
      </div>
    </section>

    <section class="mlpr-stats-section">
      <h3 class="mlpr-stats-section-title">${t('antennaStats')}</h3>
      <p class="mlpr-scope-note">${t('antennaStatsScope')}</p>
      <div class="mlpr-tiles-grid" id="mlpr-antenna-signal-tiles"></div>
      <div class="mlpr-stats-grid">
        <section class="mlpr-stat-chart">
          <p class="mlpr-chart-label">${t('antennaRangeByAltitude')}</p>
          <div id="mlpr-antenna-chart-bands"></div>
          <div class="mlpr-chart-legend" id="mlpr-antenna-legend-bands"></div>
        </section>
        <section class="mlpr-stat-chart mlpr-stat-chart-doughnut">
          <p class="mlpr-chart-label">${t('antennaCoverageRose')}</p>
          <div id="mlpr-antenna-chart-rose"></div>
        </section>
      </div>
    </section>

    <section class="mlpr-stat-chart">
      <p class="mlpr-chart-label">${t('allRegistrations')}</p>
      <button type="button" id="mlpr-load-registrations" class="mlpr-detail-expand">${t('showRegistrations')}</button>
      <div id="mlpr-reg-controls" style="display:none">
        <input type="search" id="mlpr-reg-search" class="mlpr-list-search" placeholder="${t('regSearchPlaceholder')}">
        <button type="button" id="mlpr-reg-export-csv">${t('exportCsv')}</button>
      </div>
      <div id="mlpr-reg-table-wrap"></div>
      <div class="mlpr-pagination" id="mlpr-reg-pagination"></div>
    </section>

    <section class="mlpr-stat-chart">
      <p class="mlpr-chart-label">${t('allAirlines')}</p>
      <button type="button" id="mlpr-load-airlines" class="mlpr-detail-expand">${t('showAllAirlines')}</button>
      <div id="mlpr-airlines-controls" style="display:none">
        <input type="search" id="mlpr-airlines-search" class="mlpr-list-search" placeholder="${t('airlinesSearchPlaceholder')}">
        <button type="button" id="mlpr-airlines-export-csv">${t('exportCsv')}</button>
      </div>
      <div id="mlpr-airlines-table-wrap"></div>
      <div class="mlpr-pagination" id="mlpr-airlines-pagination"></div>
    </section>
  `;

  const rangeSelectorEl = container.querySelector('#mlpr-stats-range');

  let homeLocation = null; // { lat, lon } | null -- fetched once per panel open, same endpoint/access-control as the home marker

  async function loadHomeLocation() {
    try {
      const response = await fetch('/api/settings');
      if (response.ok) {
        const data = await response.json();
        homeLocation =
          typeof data.homeLat === 'number' && typeof data.homeLon === 'number'
            ? { lat: data.homeLat, lon: data.homeLon }
            : null;
      }
    } catch {
      // Offline/unreachable -- keep whatever we last knew.
    }
    drawNowSection();
  }

  // The four live counters are structurally identical every time -- only
  // their numbers move -- so the tiles are built once and then have their
  // value text replaced. Rebuilding this via innerHTML on every radar-state
  // change (about once a second) was cheap in absolute terms but it threw
  // away and recreated the elements each time, which drops any text
  // selection inside them and forces a layout pass for numbers that often
  // hadn't changed at all.
  const NOW_TILES = [
    // Counted from the browser's own live set, the one the map and the
    // List panel are drawn from -- not from a separate server-sent number,
    // which is how this tile and the List's own total used to disagree.
    { labelKey: 'aircraftCount', value: ({ aircraft }) => String(aircraft.length) },
    { labelKey: 'chartWithPos', value: ({ withPosition }) => String(withPosition) },
    {
      labelKey: 'messagesPerSecond',
      value: ({ stats }) => (typeof stats.messagesPerSec === 'number' ? stats.messagesPerSec.toFixed(1) : '–'),
    },
    {
      labelKey: 'maxRangeLastHour',
      value: ({ stats, units }) => formatDistance(stats.maxRangeLastHourKm, units) ?? '–',
    },
  ];
  let nowTileValueEls = null;

  function ensureNowTiles() {
    if (nowTileValueEls) return;
    const el = container.querySelector('#mlpr-now-tiles');
    el.innerHTML = NOW_TILES.map((tile) => tileHtml(t(tile.labelKey), '')).join('');
    nowTileValueEls = [...el.querySelectorAll('.mlpr-tile-value')];
  }

  function drawNowSection() {
    const stats = getLiveStats();
    const { units } = getSettings();
    const aircraft = getLiveAircraft();
    const withPosition = aircraft.filter((a) => typeof a.lat === 'number' && typeof a.lon === 'number').length;

    ensureNowTiles();
    const context = { stats, units, withPosition, aircraft };
    NOW_TILES.forEach((tile, i) => {
      const next = tile.value(context);
      // Skip the assignment when nothing moved: aircraft count and max range
      // are stable for long stretches, and not touching the node at all is
      // strictly cheaper than writing the same string back.
      if (nowTileValueEls[i].textContent !== next) nowTileValueEls[i].textContent = next;
    });

    // Left as an innerHTML rebuild deliberately: unlike the counters above,
    // these tiles change shape as well as value (a different aircraft, a
    // different set of available chips, or the "no receiver location"
    // fallback), so there is no stable structure to write into.
    const { nearest, farthest } = findNearestFarthest(aircraft, homeLocation);
    const emptyMessage = homeLocation ? t('noAircraftWithPosition') : t('homeNotConfiguredShort');
    const aircraftTilesHtml =
      aircraftTileHtml(t('tileNearest'), nearest, units, emptyMessage) +
      aircraftTileHtml(t('tileFarthest'), farthest, units, emptyMessage);
    const aircraftTilesEl = container.querySelector('#mlpr-now-aircraft-tiles');
    if (aircraftTilesEl.innerHTML !== aircraftTilesHtml) aircraftTilesEl.innerHTML = aircraftTilesHtml;
  }

  function drawRangeSelector() {
    rangeSelectorEl.innerHTML = RANGES.map(
      (range) =>
        `<button type="button" class="mlpr-range-btn${range === currentRange ? ' active' : ''}" data-range="${range}">${t(RANGE_LABEL_KEYS[range])}</button>`,
    ).join('');

    for (const btn of rangeSelectorEl.querySelectorAll('.mlpr-range-btn')) {
      btn.addEventListener('click', () => {
        if (currentRange === btn.dataset.range) return;
        currentRange = btn.dataset.range;
        persistRange(currentRange);
        drawRangeSelector();
        drawSummarySection();
        drawCharts();
      });
    }
  }

  // Shared empty state for every chart type: an empty bucket array (a
  // fresh install with no daily_stats rows yet, or a range with no data in
  // it) gets a plain "no data yet" message instead of a silently blank box.
  function emptyChartMessage(el) {
    el.innerHTML = `<p class="mlpr-empty">${t('noStatsData')}</p>`;
  }

  // Every chart div starts truly empty (see the container.innerHTML template
  // above) and each chart does its own fetch, so without this a slow
  // request (a real possibility for "all time" on a well-established
  // install) reads as a blank box -- indistinguishable from "no data yet"
  // until the response lands. Set for every chart at the start of
  // drawCharts(), before any of its awaits.
  function loadingChartMessage(el) {
    el.innerHTML = `<p class="mlpr-empty">${t('loadingStats')}</p>`;
  }

  function drawAircraftCountChart(history) {
    const el = container.querySelector('#mlpr-chart-aircraft-count');
    const legendEl = container.querySelector('#mlpr-legend-aircraft-count');
    if (history.length === 0) {
      emptyChartMessage(el);
      legendEl.innerHTML = '';
      return;
    }
    const series = [
      { key: 'avgAircraft', color: '#3d8bdc', label: t('chartAircraftCountAvg') },
      { key: 'maxAircraft', color: '#3ddc84', label: t('chartAircraftCountMax') },
    ];
    el.innerHTML = renderLineChartSvg(history, series);
    const lastAvg = Math.round(history[history.length - 1].avgAircraft);
    const lastMax = history[history.length - 1].maxAircraft;
    legendEl.innerHTML =
      legendItemHtml('#3d8bdc', t('chartAircraftCountAvg'), lastAvg) + legendItemHtml('#3ddc84', t('chartAircraftCountMax'), lastMax);
    wireChartTooltip(el, history, series);
  }

  function drawPositionChart(history) {
    const el = container.querySelector('#mlpr-chart-position');
    const legendEl = container.querySelector('#mlpr-legend-position');
    if (history.length === 0) {
      emptyChartMessage(el);
      legendEl.innerHTML = '';
      return;
    }
    const series = [
      { key: 'avgWithPos', color: '#3ddc84', label: t('chartWithPos') },
      { key: 'avgWithoutPos', color: '#e03131', label: t('chartWithoutPos') },
    ];
    el.innerHTML = renderAreaChartSvg(history, series);
    legendEl.innerHTML = legendItemHtml('#3ddc84', t('chartWithPos')) + legendItemHtml('#e03131', t('chartWithoutPos'));
    wireChartTooltip(el, history, series);
  }

  function drawNewRegistrationsChart(buckets) {
    const el = container.querySelector('#mlpr-chart-new-registrations');
    if (buckets.length === 0) {
      emptyChartMessage(el);
      return;
    }
    const series = [{ key: 'count', color: '#3ddc84', label: t('chartNewRegistrations') }];
    el.innerHTML = renderBarChartSvg(buckets, series);
    wireChartTooltip(el, buckets, series);
  }

  function drawDoughnut(elId, legendId, items, labelFor) {
    const el = container.querySelector(elId);
    const legendEl = container.querySelector(legendId);
    if (items.length === 0) {
      el.innerHTML = '';
      emptyChartMessage(legendEl);
      return;
    }
    const labeledItems = items.map((i) => ({ label: labelFor(i.key), value: i.count }));
    const slices = doughnutSlices(labeledItems, { otherLabel: t('otherSlice') });
    const total = slices.reduce((sum, s) => sum + s.value, 0) || 1;
    el.innerHTML = renderDoughnutSvg(labeledItems, {
      otherLabel: t('otherSlice'),
      centerLabel: String(total),
      centerSublabel: t('doughnutTotal'),
    });
    legendEl.innerHTML = slices
      .map((s, i) => doughnutLegendItemHtml(DOUGHNUT_COLORS[i % DOUGHNUT_COLORS.length], s.label, s.value, Math.round((s.value / total) * 100), i))
      .join('');
    wireDoughnutTooltip(el, legendEl, slices);
  }

  function drawLineTrend(elId, legendId, buckets, topKeys, labelFor) {
    const el = container.querySelector(elId);
    const legendEl = container.querySelector(legendId);
    if (buckets.length === 0 || topKeys.length === 0) {
      el.innerHTML = '';
      emptyChartMessage(legendEl);
      return;
    }
    const series = topKeys.map((key, i) => ({ key, color: DOUGHNUT_COLORS[i % DOUGHNUT_COLORS.length], label: labelFor(key) }));
    el.innerHTML = renderLineChartSvg(buckets, series);
    legendEl.innerHTML = topKeys.map((key, i) => legendItemHtml(DOUGHNUT_COLORS[i % DOUGHNUT_COLORS.length], labelFor(key))).join('');
    wireChartTooltip(el, buckets, series);
  }

  async function drawTopChart(kind, elId, legendId, countsUrl, labelFor, extractKey, forceRefresh = true) {
    const counts = await fetchTopChartCounts(kind, countsUrl, currentRange, forceRefresh);
    const view = chartView[kind];

    if (view === 'doughnut') {
      drawDoughnut(elId, legendId, counts.map((entry) => ({ key: extractKey(entry), count: entry.count })), labelFor);
      return;
    }

    const topKeys = counts
      .map((entry) => extractKey(entry))
      .filter(Boolean)
      .slice(0, TREND_TOP_N);
    const field = kind === 'topType' ? 'type' : 'airline';
    const buckets = await fetchJson(
      `/api/stats/registrations-trend?range=${currentRange}&field=${field}&keys=${topKeys.map(encodeURIComponent).join(',')}`,
      [],
    );
    drawLineTrend(elId, legendId, buckets, topKeys, labelFor);
  }

  async function drawTypeChart(forceRefresh = true) {
    await drawTopChart('topType', '#mlpr-chart-top-type', '#mlpr-legend-top-type', `/api/stats/types?range=${currentRange}`, (typeCode) => typeCode, (e) => e.typeCode, forceRefresh);
  }

  async function drawAirlineChart(forceRefresh = true) {
    const airlines = await getAirlinesMap();
    await drawTopChart(
      'topAirline',
      '#mlpr-chart-top-airline',
      '#mlpr-legend-top-airline',
      `/api/stats/airlines?range=${currentRange}`,
      (icao) => airlines.get(icao)?.name ?? icao,
      (e) => e.airlineIcao,
      forceRefresh,
    );
  }

  function wireChartViewToggles() {
    for (const toggle of container.querySelectorAll('.mlpr-chart-view-toggle')) {
      const kind = toggle.dataset.chart;
      for (const btn of toggle.querySelectorAll('.mlpr-range-btn')) {
        btn.addEventListener('click', () => {
          if (chartView[kind] === btn.dataset.view) return;
          chartView[kind] = btn.dataset.view;
          for (const sibling of toggle.querySelectorAll('.mlpr-range-btn')) {
            sibling.classList.toggle('active', sibling === btn);
          }
          // Just switching views, not a new range -- reuse the counts
          // already fetched for the current range instead of re-fetching
          // from scratch (see topChartCountsCache above).
          if (kind === 'topType') drawTypeChart(false);
          else drawAirlineChart(false);
        });
      }
    }
  }

  async function drawCharts() {
    for (const el of container.querySelectorAll('[id^="mlpr-chart-"]')) {
      loadingChartMessage(el);
    }
    for (const el of container.querySelectorAll('[id^="mlpr-legend-"]')) {
      el.innerHTML = '';
    }

    const history = await fetchJson(`/api/stats/history?range=${currentRange}`, []);
    drawAircraftCountChart(history);
    drawPositionChart(history);

    const newRegistrations = await fetchJson(`/api/stats/new-registrations?range=${currentRange}`, []);
    drawNewRegistrationsChart(newRegistrations);

    await drawTypeChart();
    await drawAirlineChart();
  }

  // One summary (tiles + top-type/top-airline doughnuts) for whichever
  // range the selector directly above it is currently on -- replaces the
  // old fixed "Today" + "All time" pair, which stayed on screen
  // unconditionally regardless of the selector and never covered 7d/31d/1y
  // at all. Server endpoint takes the exact same range values as every
  // other stats fetch (see /api/stats/summary in server.js).
  async function drawSummarySection() {
    const titleEl = container.querySelector('#mlpr-summary-title');
    if (titleEl) titleEl.textContent = t(RANGE_LABEL_KEYS[currentRange]);

    const { units } = getSettings();
    const summary = await fetchJson(`/api/stats/summary?range=${currentRange}`, null);
    const tilesEl = container.querySelector('#mlpr-summary-tiles');
    if (!summary) {
      tilesEl.innerHTML = '';
      return;
    }

    // The max-range tile is the *only* place the all-time range record is
    // visible (on the "all" range it reads the very value the "new range
    // record" notification fires on), which is why the time-bucketed range
    // chart was dropped instead when these two turned out to overlap: a
    // record is a single number, and a chart of it over time was the
    // weaker of the two ways to show that.
    //
    // The type/airline breakdown likewise used to be drawn here *as well
    // as* by drawTypeChart/drawAirlineChart -- same range, same server-side
    // function (getTypeCounts), same label, twice on one screen. The
    // surviving pair is the one with the doughnut/line toggle, moved up
    // into this section where a breakdown-of-the-range belongs.
    tilesEl.innerHTML = [
      tileHtml(t('tileAircraftSeen'), String(summary.aircraftSeenCount)),
      tileHtml(t('tileAircraftTracked'), String(summary.aircraftTrackedCount), t('aircraftTrackedHint')),
      tileHtml(t('tileUniqueFlights'), String(summary.uniqueFlightsCount)),
      tileHtml(t('maxRange'), formatDistance(summary.maxRangeKm, units) ?? '–'),
    ].join('');
  }

  async function drawAntennaSection() {
    const { units } = getSettings();
    const data = await fetchJson('/api/stats/antenna', null);

    const signalTilesEl = container.querySelector('#mlpr-antenna-signal-tiles');
    if (!data || typeof data.signalDbfs !== 'number') {
      signalTilesEl.innerHTML = `<p class="mlpr-empty">${t('antennaNoSignalData')}</p>`;
    } else {
      signalTilesEl.innerHTML = [
        tileHtml(t('antennaSignalMean'), `${data.signalDbfs.toFixed(1)} dBFS`),
        typeof data.peakSignalDbfs === 'number' ? tileHtml(t('antennaSignalPeak'), `${data.peakSignalDbfs.toFixed(1)} dBFS`) : '',
      ].join('');
    }

    const bandsEl = container.querySelector('#mlpr-antenna-chart-bands');
    const bandsLegendEl = container.querySelector('#mlpr-antenna-legend-bands');
    const roseEl = container.querySelector('#mlpr-antenna-chart-rose');
    if (!data || data.altitudeBands.every((b) => b.maxRangeKm === 0)) {
      emptyChartMessage(bandsEl);
      bandsLegendEl.innerHTML = '';
      emptyChartMessage(roseEl);
      return;
    }

    const bandBuckets = data.altitudeBands.map((b) => ({ bucket: b.label, maxRangeKm: b.maxRangeKm, topAvgRangeKm: b.topAvgRangeKm }));
    const bandSeries = [
      { key: 'maxRangeKm', color: '#3ddc84', label: t('chartRangeMax') },
      { key: 'topAvgRangeKm', color: '#3d8bdc', label: t('chartRangeTopAvg') },
    ];
    const bandFormatValue = (v) => formatDistance(v, units);
    const bandFormatBucket = (label) => label;
    bandsEl.innerHTML = renderBarChartSvg(bandBuckets, bandSeries, { formatValue: bandFormatValue, formatBucket: bandFormatBucket });
    bandsLegendEl.innerHTML =
      legendItemHtml('#3ddc84', t('chartRangeMax')) + legendItemHtml('#3d8bdc', t('chartRangeTopAvg'));
    wireChartTooltip(bandsEl, bandBuckets, bandSeries, { formatValue: bandFormatValue, formatBucket: bandFormatBucket });
    // The rose uses the outlier-resistant top-5 average as its petal radius
    // (not the single all-time max) -- the whole point of the redesign was
    // to avoid VRS's/tar1090's spiky single-sample plots; the map coverage
    // layer (Settings -> Map) is where the max is drawn too, as a separate
    // thin outline around this same fill. Collapsed from the server's full
    // 180-sector resolution down to ROSE_DISPLAY_SECTORS wide wedges
    // (mergeRoseSectors) -- at full resolution this was dozens of
    // near-invisible slivers blurring into visual noise, reported live.
    // Only this Stats-page rose is coarsened; the on-map coverage polygon
    // (a smooth filled/outlined shape, not discrete wedges) keeps the full
    // 180-point resolution, since that's what makes it read as a shape
    // rather than a jagged VRS/tar1090-style starburst in the first place.
    const roseItems = mergeRoseSectors(data.sectors.map((s) => ({ value: s.topAvgRangeKm })), ROSE_DISPLAY_SECTORS);
    const roseFormatValue = (v) => formatDistance(v, units);
    roseEl.innerHTML = renderRoseChartSvg(roseItems, { formatValue: roseFormatValue });
    wireRoseTooltip(roseEl, roseItems, { formatValue: roseFormatValue });
  }

  function watchEntryRowHtml(entry, airlines) {
    return `
      <tr>
        <td>${escapeHtml(entry.registration)}</td>
        <td>${escapeHtml(entry.typeCode ?? '—')}</td>
        <td>${escapeHtml(entry.airlineIcao ? (airlines.get(entry.airlineIcao)?.name ?? entry.airlineIcao) : '—')}</td>
        <td>${new Date(entry.firstSeenAt).toLocaleString()}</td>
        <td>${entry.timesSeen}</td>
        <td>${new Date(entry.lastSeenAt).toLocaleString()}</td>
      </tr>`;
  }

  // `value()` mirrors exactly what rowHtml() above shows on screen (the
  // resolved airline name, locale-formatted dates) rather than the raw
  // entry field -- used by the CSV export below so a downloaded file
  // matches what's actually visible in the table, not the underlying JSON
  // shape.
  const REGISTRATIONS_COLUMNS = [
    { key: 'registration', label: () => t('colRegistration'), value: (e) => e.registration },
    { key: 'typeCode', label: () => t('colType'), value: (e) => e.typeCode ?? '' },
    {
      key: 'airlineIcao',
      label: () => t('colAirline'),
      value: (e, airlines) => (e.airlineIcao ? (airlines.get(e.airlineIcao)?.name ?? e.airlineIcao) : ''),
    },
    { key: 'firstSeenAt', label: () => t('colFirstSeen'), value: (e) => new Date(e.firstSeenAt).toLocaleString() },
    { key: 'timesSeen', label: () => t('colTimesSeen'), value: (e) => e.timesSeen },
    { key: 'lastSeenAt', label: () => t('colLastSeen'), value: (e) => new Date(e.lastSeenAt).toLocaleString() },
  ];

  function airlineRowHtml(entry, airlines) {
    return `
      <tr>
        <td>${escapeHtml(airlines.get(entry.airlineIcao)?.name ?? entry.airlineIcao)}</td>
        <td>${escapeHtml(entry.airlineIcao)}</td>
        <td>${entry.registrationsCount}</td>
        <td>${entry.totalTimesSeen}</td>
        <td>${new Date(entry.firstSeenAt).toLocaleString()}</td>
        <td>${new Date(entry.lastSeenAt).toLocaleString()}</td>
      </tr>`;
  }

  const AIRLINES_COLUMNS = [
    { key: 'name', label: () => t('colAirline'), value: (e, airlines) => airlines.get(e.airlineIcao)?.name ?? e.airlineIcao },
    { key: 'airlineIcao', label: () => t('colAirlineIcao'), value: (e) => e.airlineIcao },
    { key: 'registrationsCount', label: () => t('colRegistrationsCount'), value: (e) => e.registrationsCount },
    { key: 'totalTimesSeen', label: () => t('colTimesSeen'), value: (e) => e.totalTimesSeen },
    { key: 'firstSeenAt', label: () => t('colFirstSeen'), value: (e) => new Date(e.firstSeenAt).toLocaleString() },
    { key: 'lastSeenAt', label: () => t('colLastSeen'), value: (e) => new Date(e.lastSeenAt).toLocaleString() },
  ];

  // Prev/first-window/current-window/last-window/next, with an ellipsis
  // wherever a gap opens up -- so a fleet of a few thousand rows (a
  // well-established install, "all time") doesn't render a hundred
  // page-number buttons in a row.
  function paginationHtml(page, totalPages) {
    if (totalPages <= 1) return '';
    const keep = new Set([1, totalPages, page - 1, page, page + 1]);
    const pages = [...keep].filter((p) => p >= 1 && p <= totalPages).sort((a, b) => a - b);

    let html = `<button type="button" class="mlpr-page-btn" data-page="${page - 1}" ${page === 1 ? 'disabled' : ''}>‹</button>`;
    let prev = 0;
    for (const p of pages) {
      if (p - prev > 1) html += `<span class="mlpr-page-ellipsis">…</span>`;
      html += `<button type="button" class="mlpr-page-btn${p === page ? ' active' : ''}" data-page="${p}">${p}</button>`;
      prev = p;
    }
    html += `<button type="button" class="mlpr-page-btn" data-page="${page + 1}" ${page === totalPages ? 'disabled' : ''}>›</button>`;
    if (page !== totalPages) {
      html += `<button type="button" class="mlpr-page-btn mlpr-page-last" data-page="${totalPages}">${t('lastPage')}</button>`;
    }
    return html;
  }

  // Shared by the registrations and all-airlines tables below: both are
  // "load on click", then search/sort/paginate *server-side* -- one request
  // per interaction returning just the visible page, instead of the old
  // shape where the whole table was fetched once and the browser did all
  // three. The pagination control was already here; this is what makes it
  // mean something (see server/src/stats-table.js).
  //
  // The airline map is still fetched for rendering, because the server
  // can't format a name into the viewer's own locale-formatted row -- but
  // it is no longer what search and sort run on.
  async function loadLazyTable({
    loadBtnId,
    controlsId,
    searchId,
    exportBtnId,
    csvFilenamePrefix,
    tableWrapId,
    paginationId,
    fetchUrl,
    columns,
    defaultSortKey,
    defaultSortAsc,
    rowHtml,
  }) {
    const tableWrap = container.querySelector(`#${tableWrapId}`);
    const paginationEl = container.querySelector(`#${paginationId}`);
    const controlsEl = container.querySelector(`#${controlsId}`);
    const searchInput = container.querySelector(`#${searchId}`);
    const exportBtn = container.querySelector(`#${exportBtnId}`);
    const loadBtn = container.querySelector(`#${loadBtnId}`);
    loadBtn.remove();
    tableWrap.innerHTML = `<p class="mlpr-empty">${t('loadingStats')}</p>`;

    const airlines = await getAirlinesMap();

    let sortKey = defaultSortKey;
    let sortAsc = defaultSortAsc;
    let page = 1;
    let query = '';
    // Every draw() is a request now, and a fast typist or a rapid click on
    // "next" can have two in flight at once. Only the newest one is allowed
    // to paint, so a slow earlier response can't overwrite a newer view.
    let latestRequest = 0;

    function queryString(overrides = {}) {
      const params = new URLSearchParams({
        search: query.trim(),
        sort: sortKey,
        dir: sortAsc ? 'asc' : 'desc',
        page: String(page),
        ...overrides,
      });
      return `${fetchUrl}?${params}`;
    }

    async function draw() {
      const requestId = ++latestRequest;
      const result = await fetchJson(queryString(), null);
      if (requestId !== latestRequest) return;

      if (!result || result.total === 0) {
        tableWrap.innerHTML = `<p class="mlpr-empty">${query.trim() ? t('noSearchResults') : t('noStatsData')}</p>`;
        paginationEl.innerHTML = '';
        return;
      }

      page = result.page;

      const sortIndicator = (key) => (sortKey === key ? (sortAsc ? ' ▲' : ' ▼') : '');
      tableWrap.innerHTML = `
        <table class="mlpr-list-table">
          <thead><tr>${columns.map((col) => `<th data-key="${col.key}">${col.label()}${sortIndicator(col.key)}</th>`).join('')}</tr></thead>
          <tbody>${result.rows.map((r) => rowHtml(r, airlines)).join('')}</tbody>
        </table>`;

      for (const th of tableWrap.querySelectorAll('th')) {
        th.addEventListener('click', () => {
          if (sortKey === th.dataset.key) {
            sortAsc = !sortAsc;
          } else {
            sortKey = th.dataset.key;
            sortAsc = true;
          }
          page = 1;
          draw();
        });
      }

      paginationEl.innerHTML = paginationHtml(result.page, result.totalPages);
      for (const btn of paginationEl.querySelectorAll('.mlpr-page-btn:not([disabled])')) {
        btn.addEventListener('click', () => {
          page = Number(btn.dataset.page);
          draw();
        });
      }
    }

    // Outside draw()'s rebuilt subtree deliberately -- same reasoning as
    // list.js's search box, so typing doesn't lose focus on every redraw.
    // Still debounced now that each keystroke would otherwise be a request.
    const runSearch = debounce(() => {
      query = searchInput.value;
      page = 1;
      draw();
    }, SEARCH_DEBOUNCE_MS);
    searchInput.addEventListener('input', runSearch);

    // The export is the one place that still wants every matching row:
    // pageSize=0 asks for the current search/sort view in full. It is an
    // explicit, occasional click, not something that happens on open --
    // which is the whole difference from how this table used to work.
    exportBtn.addEventListener('click', async () => {
      exportBtn.disabled = true;
      try {
        const result = await fetchJson(queryString({ pageSize: '0' }), null);
        if (!result) return;
        const csv = rowsToCsv(columns, result.rows, airlines);
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `${csvFilenamePrefix}-${new Date().toISOString().slice(0, 10)}.csv`;
        link.click();
        URL.revokeObjectURL(url);
      } finally {
        exportBtn.disabled = false;
      }
    });

    controlsEl.style.display = '';
    draw();
  }

  container.querySelector('#mlpr-load-registrations').addEventListener(
    'click',
    () =>
      loadLazyTable({
        loadBtnId: 'mlpr-load-registrations',
        controlsId: 'mlpr-reg-controls',
        searchId: 'mlpr-reg-search',
        exportBtnId: 'mlpr-reg-export-csv',
        csvFilenamePrefix: 'mlpr-registrations',
        tableWrapId: 'mlpr-reg-table-wrap',
        paginationId: 'mlpr-reg-pagination',
        fetchUrl: '/api/stats/registrations',
        columns: REGISTRATIONS_COLUMNS,
        // Default view: the most-often-seen aircraft first, rather than
        // most-recently-seen -- "most popular" is what a spotter actually
        // wants to see by default; recency is still one click away. Sent
        // explicitly on the first request, and mirrored by the server's own
        // defaultSort so a request without it lands on the same view.
        defaultSortKey: 'timesSeen',
        defaultSortAsc: false,
        rowHtml: watchEntryRowHtml,
      }),
    { once: true },
  );

  container.querySelector('#mlpr-load-airlines').addEventListener(
    'click',
    () =>
      loadLazyTable({
        loadBtnId: 'mlpr-load-airlines',
        controlsId: 'mlpr-airlines-controls',
        searchId: 'mlpr-airlines-search',
        exportBtnId: 'mlpr-airlines-export-csv',
        csvFilenamePrefix: 'mlpr-airlines',
        tableWrapId: 'mlpr-airlines-table-wrap',
        paginationId: 'mlpr-airlines-pagination',
        fetchUrl: '/api/stats/all-airlines',
        columns: AIRLINES_COLUMNS,
        defaultSortKey: 'registrationsCount',
        defaultSortAsc: false,
        rowHtml: airlineRowHtml,
      }),
    { once: true },
  );

  wireChartViewToggles();
  loadHomeLocation();
  drawRangeSelector();
  drawCharts();
  drawSummarySection();
  drawAntennaSection();

  const unsubscribeAircraft = onChange(drawNowSection);
  const unsubscribeSettings = onSettingsChange(drawNowSection);
  // Every one of these is a fetch (six-plus endpoints between them), so a
  // backgrounded tab with Stats left open was re-pulling the whole set
  // every 20 seconds for nobody -- browsers throttle the timer but not the
  // requests it fires. Skipped while hidden and run once on the way back,
  // so returning to the tab shows current figures rather than whatever was
  // on screen when it was backgrounded.
  function refreshAll() {
    drawCharts();
    drawSummarySection();
    drawAntennaSection();
  }

  const refreshTimer = setInterval(() => {
    if (document.visibilityState === 'hidden') return;
    refreshAll();
  }, HISTORY_REFRESH_MS);

  function onVisibilityChange() {
    if (document.visibilityState !== 'hidden') refreshAll();
  }
  document.addEventListener('visibilitychange', onVisibilityChange);

  return () => {
    unsubscribeAircraft();
    unsubscribeSettings();
    clearInterval(refreshTimer);
    // Must be removed with the rest -- renderStatsPanel runs again on every
    // panel open, so a listener left behind would keep a closed panel's
    // stale closure alive and refetching on every future tab focus.
    document.removeEventListener('visibilitychange', onVisibilityChange);
  };
}
