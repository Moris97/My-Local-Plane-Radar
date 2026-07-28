import { t } from './i18n.js';
import { getLiveStats, getLiveAircraft, onChange } from './radar-state.js';
import { getSettings, onSettingsChange } from './settings-state.js';
import {
  renderLineChartSvg,
  renderAreaChartSvg,
  renderBarChartSvg,
  renderDoughnutSvg,
  renderRoseChartSvg,
  doughnutSlices,
  DOUGHNUT_COLORS,
} from './chart.js';
import { formatDistance, formatAltitude, formatSpeed } from './units.js';
import { findNearestFarthest } from './geo.js';

const HISTORY_REFRESH_MS = 20000;
const TABLE_PAGE_SIZE = 20;
const TREND_TOP_N = 5;

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

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function legendItemHtml(color, label, value) {
  return `<span class="mlpr-chart-legend-item"><span class="mlpr-chart-legend-swatch" style="background:${color}"></span>${escapeHtml(label)}${value != null ? `: ${escapeHtml(value)}` : ''}</span>`;
}

function tileHtml(label, value) {
  return `<div class="mlpr-tile"><div class="mlpr-tile-label">${escapeHtml(label)}</div><div class="mlpr-tile-value">${escapeHtml(value)}</div></div>`;
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

    <section class="mlpr-stats-section">
      <h3 class="mlpr-stats-section-title">${t('statsToday')}</h3>
      <div class="mlpr-tiles-grid" id="mlpr-today-tiles"></div>
      <div class="mlpr-stats-grid">
        <section class="mlpr-stat-chart mlpr-stat-chart-doughnut">
          <p class="mlpr-chart-label">${t('chartTopType')}</p>
          <div id="mlpr-today-chart-type"></div>
          <div class="mlpr-chart-legend" id="mlpr-today-legend-type"></div>
        </section>
        <section class="mlpr-stat-chart mlpr-stat-chart-doughnut">
          <p class="mlpr-chart-label">${t('chartTopAirline')}</p>
          <div id="mlpr-today-chart-airline"></div>
          <div class="mlpr-chart-legend" id="mlpr-today-legend-airline"></div>
        </section>
      </div>
    </section>

    <section class="mlpr-stats-section">
      <h3 class="mlpr-stats-section-title">${t('statsAllTime')}</h3>
      <div class="mlpr-tiles-grid" id="mlpr-alltime-tiles"></div>
      <div class="mlpr-stats-grid">
        <section class="mlpr-stat-chart mlpr-stat-chart-doughnut">
          <p class="mlpr-chart-label">${t('chartTopType')}</p>
          <div id="mlpr-alltime-chart-type"></div>
          <div class="mlpr-chart-legend" id="mlpr-alltime-legend-type"></div>
        </section>
        <section class="mlpr-stat-chart mlpr-stat-chart-doughnut">
          <p class="mlpr-chart-label">${t('chartTopAirline')}</p>
          <div id="mlpr-alltime-chart-airline"></div>
          <div class="mlpr-chart-legend" id="mlpr-alltime-legend-airline"></div>
        </section>
      </div>
    </section>

    <section class="mlpr-stats-section">
      <div class="mlpr-stats-range" id="mlpr-stats-range"></div>

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
          <p class="mlpr-chart-label">${t('chartRange')}</p>
          <div id="mlpr-chart-range"></div>
          <div class="mlpr-chart-legend" id="mlpr-legend-range"></div>
        </section>

        <section class="mlpr-stat-chart">
          <p class="mlpr-chart-label">${t('chartNewRegistrations')}</p>
          <div id="mlpr-chart-new-registrations"></div>
        </section>

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
    </section>

    <section class="mlpr-stats-section">
      <h3 class="mlpr-stats-section-title">${t('antennaStats')}</h3>
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
      </div>
      <div id="mlpr-reg-table-wrap"></div>
      <div class="mlpr-pagination" id="mlpr-reg-pagination"></div>
    </section>

    <section class="mlpr-stat-chart">
      <p class="mlpr-chart-label">${t('allAirlines')}</p>
      <button type="button" id="mlpr-load-airlines" class="mlpr-detail-expand">${t('showAllAirlines')}</button>
      <div id="mlpr-airlines-controls" style="display:none">
        <input type="search" id="mlpr-airlines-search" class="mlpr-list-search" placeholder="${t('airlinesSearchPlaceholder')}">
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

  function drawNowSection() {
    const stats = getLiveStats();
    const { units } = getSettings();
    const aircraft = getLiveAircraft();
    const withPosition = aircraft.filter((a) => typeof a.lat === 'number' && typeof a.lon === 'number').length;

    container.querySelector('#mlpr-now-tiles').innerHTML = [
      tileHtml(t('aircraftCount'), String(stats.aircraftCount ?? 0)),
      tileHtml(t('chartWithPos'), String(withPosition)),
      tileHtml(t('messagesPerSecond'), typeof stats.messagesPerSec === 'number' ? stats.messagesPerSec.toFixed(1) : '–'),
      tileHtml(t('maxRangeLastHour'), formatDistance(stats.maxRangeLastHourKm, units) ?? '–'),
    ].join('');

    const { nearest, farthest } = findNearestFarthest(aircraft, homeLocation);
    const emptyMessage = homeLocation ? t('noAircraftWithPosition') : t('homeNotConfiguredShort');
    container.querySelector('#mlpr-now-aircraft-tiles').innerHTML =
      aircraftTileHtml(t('tileNearest'), nearest, units, emptyMessage) +
      aircraftTileHtml(t('tileFarthest'), farthest, units, emptyMessage);
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
      { key: 'avgAircraft', color: '#3d8bdc' },
      { key: 'maxAircraft', color: '#3ddc84' },
    ];
    el.innerHTML = renderLineChartSvg(history, series);
    const lastAvg = Math.round(history[history.length - 1].avgAircraft);
    const lastMax = history[history.length - 1].maxAircraft;
    legendEl.innerHTML =
      legendItemHtml('#3d8bdc', t('chartAircraftCountAvg'), lastAvg) + legendItemHtml('#3ddc84', t('chartAircraftCountMax'), lastMax);
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
      { key: 'avgWithPos', color: '#3ddc84' },
      { key: 'avgWithoutPos', color: '#e03131' },
    ];
    el.innerHTML = renderAreaChartSvg(history, series);
    legendEl.innerHTML = legendItemHtml('#3ddc84', t('chartWithPos')) + legendItemHtml('#e03131', t('chartWithoutPos'));
  }

  function drawRangeChart(history) {
    const { units } = getSettings();
    const el = container.querySelector('#mlpr-chart-range');
    const legendEl = container.querySelector('#mlpr-legend-range');
    if (history.length === 0) {
      emptyChartMessage(el);
      legendEl.innerHTML = '';
      return;
    }
    const series = [
      { key: 'maxRangeKm', color: '#3ddc84' },
      { key: 'rangeTopAvgKm', color: '#3d8bdc' },
    ];
    el.innerHTML = renderBarChartSvg(history, series, { formatValue: (v) => formatDistance(v, units) });
    const last = history[history.length - 1];
    legendEl.innerHTML =
      legendItemHtml('#3ddc84', t('chartRangeMax'), formatDistance(last.maxRangeKm, units)) +
      legendItemHtml('#3d8bdc', t('chartRangeTopAvg'), formatDistance(last.rangeTopAvgKm, units));
  }

  function drawNewRegistrationsChart(buckets) {
    const el = container.querySelector('#mlpr-chart-new-registrations');
    if (buckets.length === 0) {
      emptyChartMessage(el);
      return;
    }
    el.innerHTML = renderBarChartSvg(buckets, [{ key: 'count', color: '#3ddc84' }]);
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
    el.innerHTML = renderDoughnutSvg(labeledItems, { otherLabel: t('otherSlice') });
    legendEl.innerHTML = slices.map((s, i) => legendItemHtml(DOUGHNUT_COLORS[i % DOUGHNUT_COLORS.length], s.label, s.value)).join('');
  }

  function drawLineTrend(elId, legendId, buckets, topKeys, labelFor) {
    const el = container.querySelector(elId);
    const legendEl = container.querySelector(legendId);
    if (buckets.length === 0 || topKeys.length === 0) {
      el.innerHTML = '';
      emptyChartMessage(legendEl);
      return;
    }
    const series = topKeys.map((key, i) => ({ key, color: DOUGHNUT_COLORS[i % DOUGHNUT_COLORS.length] }));
    el.innerHTML = renderLineChartSvg(buckets, series);
    legendEl.innerHTML = topKeys.map((key, i) => legendItemHtml(DOUGHNUT_COLORS[i % DOUGHNUT_COLORS.length], labelFor(key))).join('');
  }

  async function drawTopChart(kind, elId, legendId, countsUrl, labelFor, extractKey) {
    const counts = await fetchJson(countsUrl, []);
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

  async function drawTypeChart() {
    await drawTopChart('topType', '#mlpr-chart-top-type', '#mlpr-legend-top-type', `/api/stats/types?range=${currentRange}`, (typeCode) => typeCode, (e) => e.typeCode);
  }

  async function drawAirlineChart() {
    const airlines = await getAirlinesMap();
    await drawTopChart(
      'topAirline',
      '#mlpr-chart-top-airline',
      '#mlpr-legend-top-airline',
      `/api/stats/airlines?range=${currentRange}`,
      (icao) => airlines.get(icao)?.name ?? icao,
      (e) => e.airlineIcao,
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
          if (kind === 'topType') drawTypeChart();
          else drawAirlineChart();
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
    drawRangeChart(history);

    const newRegistrations = await fetchJson(`/api/stats/new-registrations?range=${currentRange}`, []);
    drawNewRegistrationsChart(newRegistrations);

    await drawTypeChart();
    await drawAirlineChart();
  }

  async function drawPeriodSection(period, tilesId, typeChartId, typeLegendId, airlineChartId, airlineLegendId) {
    const { units } = getSettings();
    const summary = await fetchJson(`/api/stats/summary?period=${period}`, null);
    if (!summary) return;

    const airlines = await getAirlinesMap();

    const tiles = [
      tileHtml(t('chartAircraftCount'), String(summary.uniqueAircraftCount)),
      tileHtml(t('tileUniqueFlights'), String(summary.uniqueFlightsCount)),
      period === 'today'
        ? tileHtml(t('chartNewRegistrations'), String(summary.newRegistrationsCount))
        : tileHtml(t('tileUniqueRegistrations'), String(summary.registrationsCount)),
      tileHtml(t('maxRange'), formatDistance(summary.maxRangeKm, units) ?? '–'),
    ];
    container.querySelector(`#${tilesId}`).innerHTML = tiles.join('');

    drawDoughnut(`#${typeChartId}`, `#${typeLegendId}`, summary.topTypes.map((e) => ({ key: e.typeCode, count: e.count })), (c) => c);
    drawDoughnut(
      `#${airlineChartId}`,
      `#${airlineLegendId}`,
      summary.topAirlines.map((e) => ({ key: e.airlineIcao, count: e.count })),
      (icao) => airlines.get(icao)?.name ?? icao,
    );
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

    bandsEl.innerHTML = renderBarChartSvg(
      data.altitudeBands.map((b) => ({ bucket: b.label, maxRangeKm: b.maxRangeKm, topAvgRangeKm: b.topAvgRangeKm })),
      [
        { key: 'maxRangeKm', color: '#3ddc84' },
        { key: 'topAvgRangeKm', color: '#3d8bdc' },
      ],
      { formatValue: (v) => formatDistance(v, units), formatBucket: (label) => label },
    );
    bandsLegendEl.innerHTML =
      legendItemHtml('#3ddc84', t('chartRangeMax')) + legendItemHtml('#3d8bdc', t('chartRangeTopAvg'));
    // The rose uses the outlier-resistant top-5 average as its petal radius
    // (not the single all-time max) -- the whole point of the redesign was
    // to avoid VRS's/tar1090's spiky single-sample plots; the map coverage
    // layer (Settings -> Map) is where the max is drawn too, as a separate
    // thin outline around this same fill.
    roseEl.innerHTML = renderRoseChartSvg(
      data.sectors.map((s) => ({ value: s.topAvgRangeKm })),
      { formatValue: (v) => formatDistance(v, units) },
    );
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

  const REGISTRATIONS_COLUMNS = [
    { key: 'registration', label: () => t('colRegistration') },
    { key: 'typeCode', label: () => t('colType') },
    { key: 'airlineIcao', label: () => t('colAirline') },
    { key: 'firstSeenAt', label: () => t('colFirstSeen') },
    { key: 'timesSeen', label: () => t('colTimesSeen') },
    { key: 'lastSeenAt', label: () => t('colLastSeen') },
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
    { key: 'name', label: () => t('colAirline') },
    { key: 'airlineIcao', label: () => t('colAirlineIcao') },
    { key: 'registrationsCount', label: () => t('colRegistrationsCount') },
    { key: 'totalTimesSeen', label: () => t('colTimesSeen') },
    { key: 'firstSeenAt', label: () => t('colFirstSeen') },
    { key: 'lastSeenAt', label: () => t('colLastSeen') },
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
  // "load on click, then sort/search/paginate entirely client-side over one
  // fetched array" -- same shape as list.js's live aircraft table, and
  // reasonable at this project's scale (a home receiver, realistically
  // hundreds to low thousands of rows even after a year).
  async function loadLazyTable({
    loadBtnId,
    controlsId,
    searchId,
    tableWrapId,
    paginationId,
    fetchUrl,
    columns,
    defaultSortKey,
    defaultSortAsc,
    rowHtml,
    matchesQuery,
  }) {
    const tableWrap = container.querySelector(`#${tableWrapId}`);
    const paginationEl = container.querySelector(`#${paginationId}`);
    const controlsEl = container.querySelector(`#${controlsId}`);
    const searchInput = container.querySelector(`#${searchId}`);
    const loadBtn = container.querySelector(`#${loadBtnId}`);
    loadBtn.remove();
    tableWrap.innerHTML = `<p class="mlpr-empty">${t('loadingStats')}</p>`;

    const [airlines, rows] = await Promise.all([getAirlinesMap(), fetchJson(fetchUrl, [])]);

    let sortKey = defaultSortKey;
    let sortAsc = defaultSortAsc;
    let page = 1;
    let query = '';

    function draw() {
      if (rows.length === 0) {
        tableWrap.innerHTML = `<p class="mlpr-empty">${t('noStatsData')}</p>`;
        paginationEl.innerHTML = '';
        return;
      }

      const filtered = rows.filter((row) => matchesQuery(row, query.trim().toLowerCase(), airlines));
      const sorted = [...filtered].sort((a, b) => {
        const cmp = String(a[sortKey] ?? '').localeCompare(String(b[sortKey] ?? ''), undefined, { numeric: true });
        return sortAsc ? cmp : -cmp;
      });

      const totalPages = Math.max(1, Math.ceil(sorted.length / TABLE_PAGE_SIZE));
      page = Math.min(page, totalPages);
      const pageRows = sorted.slice((page - 1) * TABLE_PAGE_SIZE, page * TABLE_PAGE_SIZE);

      if (pageRows.length === 0) {
        tableWrap.innerHTML = `<p class="mlpr-empty">${t('noSearchResults')}</p>`;
      } else {
        const sortIndicator = (key) => (sortKey === key ? (sortAsc ? ' ▲' : ' ▼') : '');
        tableWrap.innerHTML = `
          <table class="mlpr-list-table">
            <thead><tr>${columns.map((col) => `<th data-key="${col.key}">${col.label()}${sortIndicator(col.key)}</th>`).join('')}</tr></thead>
            <tbody>${pageRows.map((r) => rowHtml(r, airlines)).join('')}</tbody>
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
      }

      paginationEl.innerHTML = paginationHtml(page, totalPages);
      for (const btn of paginationEl.querySelectorAll('.mlpr-page-btn:not([disabled])')) {
        btn.addEventListener('click', () => {
          page = Number(btn.dataset.page);
          draw();
        });
      }
    }

    // Outside draw()'s rebuilt subtree deliberately -- same reasoning as
    // list.js's search box, so typing doesn't lose focus on every redraw.
    searchInput.addEventListener('input', () => {
      query = searchInput.value;
      page = 1;
      draw();
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
        tableWrapId: 'mlpr-reg-table-wrap',
        paginationId: 'mlpr-reg-pagination',
        fetchUrl: '/api/stats/registrations',
        columns: REGISTRATIONS_COLUMNS,
        // Default view: the 20 most-often-seen aircraft first, rather than
        // most-recently-seen -- "most popular" is what a spotter actually
        // wants to see by default; recency is still one click away.
        defaultSortKey: 'timesSeen',
        defaultSortAsc: false,
        rowHtml: watchEntryRowHtml,
        matchesQuery: (entry, needle, airlines) => {
          if (!needle) return true;
          const airlineName = entry.airlineIcao ? (airlines.get(entry.airlineIcao)?.name ?? entry.airlineIcao) : '';
          return [entry.registration, entry.typeCode, entry.airlineIcao, airlineName].some((value) =>
            String(value ?? '').toLowerCase().includes(needle),
          );
        },
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
        tableWrapId: 'mlpr-airlines-table-wrap',
        paginationId: 'mlpr-airlines-pagination',
        fetchUrl: '/api/stats/all-airlines',
        columns: AIRLINES_COLUMNS,
        defaultSortKey: 'registrationsCount',
        defaultSortAsc: false,
        rowHtml: airlineRowHtml,
        matchesQuery: (entry, needle, airlines) => {
          if (!needle) return true;
          const airlineName = airlines.get(entry.airlineIcao)?.name ?? '';
          return [entry.airlineIcao, airlineName].some((value) => String(value ?? '').toLowerCase().includes(needle));
        },
      }),
    { once: true },
  );

  function drawPeriodSections() {
    drawPeriodSection('today', 'mlpr-today-tiles', 'mlpr-today-chart-type', 'mlpr-today-legend-type', 'mlpr-today-chart-airline', 'mlpr-today-legend-airline');
    drawPeriodSection('all', 'mlpr-alltime-tiles', 'mlpr-alltime-chart-type', 'mlpr-alltime-legend-type', 'mlpr-alltime-chart-airline', 'mlpr-alltime-legend-airline');
  }

  wireChartViewToggles();
  loadHomeLocation();
  drawRangeSelector();
  drawCharts();
  drawPeriodSections();
  drawAntennaSection();

  const unsubscribeAircraft = onChange(drawNowSection);
  const unsubscribeSettings = onSettingsChange(drawNowSection);
  const refreshTimer = setInterval(() => {
    drawCharts();
    drawPeriodSections();
    drawAntennaSection();
  }, HISTORY_REFRESH_MS);

  return () => {
    unsubscribeAircraft();
    unsubscribeSettings();
    clearInterval(refreshTimer);
  };
}
