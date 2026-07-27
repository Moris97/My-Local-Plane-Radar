import { t } from './i18n.js';
import { getLiveStats, onChange } from './radar-state.js';
import { getSettings, onSettingsChange } from './settings-state.js';
import {
  renderLineChartSvg,
  renderAreaChartSvg,
  renderBarChartSvg,
  renderDoughnutSvg,
  doughnutSlices,
  DOUGHNUT_COLORS,
} from './chart.js';
import { formatDistance } from './units.js';

const HISTORY_REFRESH_MS = 20000;
const REGISTRATIONS_PAGE_SIZE = 20;

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

export function renderStatsPanel(container) {
  container.innerHTML = `
    <dl class="mlpr-stats">
      <dt>${t('aircraftCount')}</dt><dd id="mlpr-stat-count">0</dd>
      <dt>${t('messagesPerSecond')}</dt><dd id="mlpr-stat-rate">–</dd>
      <dt>${t('maxRange')}</dt><dd id="mlpr-stat-range">–</dd>
    </dl>

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
        <p class="mlpr-chart-label">${t('chartTopType')}</p>
        <div id="mlpr-chart-top-type"></div>
        <div class="mlpr-chart-legend" id="mlpr-legend-top-type"></div>
      </section>

      <section class="mlpr-stat-chart mlpr-stat-chart-doughnut">
        <p class="mlpr-chart-label">${t('chartTopAirline')}</p>
        <div id="mlpr-chart-top-airline"></div>
        <div class="mlpr-chart-legend" id="mlpr-legend-top-airline"></div>
        <p class="mlpr-chart-attribution">Airline data: <a href="https://openflights.org/data.php" target="_blank" rel="noopener">OpenFlights</a> (ODbL)</p>
      </section>
    </div>

    <section class="mlpr-stat-chart">
      <p class="mlpr-chart-label">${t('allRegistrations')}</p>
      <button type="button" id="mlpr-load-registrations" class="mlpr-detail-expand">${t('showRegistrations')}</button>
      <div id="mlpr-reg-controls" style="display:none">
        <input type="search" id="mlpr-reg-search" class="mlpr-list-search" placeholder="${t('regSearchPlaceholder')}">
      </div>
      <div id="mlpr-reg-table-wrap"></div>
      <div class="mlpr-pagination" id="mlpr-reg-pagination"></div>
    </section>
  `;

  const countEl = container.querySelector('#mlpr-stat-count');
  const rateEl = container.querySelector('#mlpr-stat-rate');
  const rangeEl = container.querySelector('#mlpr-stat-range');
  const rangeSelectorEl = container.querySelector('#mlpr-stats-range');

  function drawLiveNumbers() {
    const stats = getLiveStats();
    const { units } = getSettings();
    countEl.textContent = String(stats.aircraftCount ?? 0);
    rateEl.textContent = typeof stats.messagesPerSec === 'number' ? stats.messagesPerSec.toFixed(1) : '–';
    rangeEl.textContent = formatDistance(stats.maxRangeKm, units) ?? '–';
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
  // below) and each chart does its own fetch, so without this a slow
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

  async function drawTypeChart() {
    const types = await fetchJson(`/api/stats/types?range=${currentRange}`, []);
    drawDoughnut(
      '#mlpr-chart-top-type',
      '#mlpr-legend-top-type',
      types.map((entry) => ({ key: entry.typeCode, count: entry.count })),
      (typeCode) => typeCode,
    );
  }

  async function drawAirlineChart() {
    const [airlines, counts] = await Promise.all([getAirlinesMap(), fetchJson(`/api/stats/airlines?range=${currentRange}`, [])]);
    drawDoughnut(
      '#mlpr-chart-top-airline',
      '#mlpr-legend-top-airline',
      counts.map((c) => ({ key: c.airlineIcao, count: c.count })),
      (icao) => airlines.get(icao)?.name ?? icao,
    );
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

  // Prev/first-window/current-window/last-window/next, with an ellipsis
  // wherever a gap opens up -- so a fleet of a few thousand registrations
  // (a well-established install, "all time" range) doesn't render a
  // hundred page-number buttons in a row.
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

  async function loadRegistrationsTable() {
    const tableWrap = container.querySelector('#mlpr-reg-table-wrap');
    const paginationEl = container.querySelector('#mlpr-reg-pagination');
    const controlsEl = container.querySelector('#mlpr-reg-controls');
    const searchInput = container.querySelector('#mlpr-reg-search');
    const loadBtn = container.querySelector('#mlpr-load-registrations');
    loadBtn.remove();
    tableWrap.innerHTML = `<p class="mlpr-empty">${t('loadingStats')}</p>`;

    const [airlines, registrations] = await Promise.all([getAirlinesMap(), fetchJson('/api/stats/registrations', [])]);

    // Default view: the 20 most-often-seen aircraft first, rather than
    // most-recently-seen -- "most popular" is what a spotter actually wants
    // to see by default; recency is still one click away via the column
    // header.
    let sortKey = 'timesSeen';
    let sortAsc = false;
    let page = 1;
    let query = '';

    function matchesQuery(entry) {
      const needle = query.trim().toLowerCase();
      if (!needle) return true;
      const airlineName = entry.airlineIcao ? (airlines.get(entry.airlineIcao)?.name ?? entry.airlineIcao) : '';
      return [entry.registration, entry.typeCode, entry.airlineIcao, airlineName].some((value) =>
        String(value ?? '').toLowerCase().includes(needle),
      );
    }

    function draw() {
      if (registrations.length === 0) {
        tableWrap.innerHTML = `<p class="mlpr-empty">${t('noStatsData')}</p>`;
        paginationEl.innerHTML = '';
        return;
      }

      const filtered = registrations.filter(matchesQuery);
      const sorted = [...filtered].sort((a, b) => {
        const cmp = String(a[sortKey] ?? '').localeCompare(String(b[sortKey] ?? ''), undefined, { numeric: true });
        return sortAsc ? cmp : -cmp;
      });

      const totalPages = Math.max(1, Math.ceil(sorted.length / REGISTRATIONS_PAGE_SIZE));
      page = Math.min(page, totalPages);
      const pageRows = sorted.slice((page - 1) * REGISTRATIONS_PAGE_SIZE, page * REGISTRATIONS_PAGE_SIZE);

      if (pageRows.length === 0) {
        tableWrap.innerHTML = `<p class="mlpr-empty">${t('noSearchResults')}</p>`;
      } else {
        const sortIndicator = (key) => (sortKey === key ? (sortAsc ? ' ▲' : ' ▼') : '');
        tableWrap.innerHTML = `
          <table class="mlpr-list-table">
            <thead><tr>${REGISTRATIONS_COLUMNS.map((col) => `<th data-key="${col.key}">${col.label()}${sortIndicator(col.key)}</th>`).join('')}</tr></thead>
            <tbody>${pageRows.map((r) => watchEntryRowHtml(r, airlines)).join('')}</tbody>
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

  container.querySelector('#mlpr-load-registrations').addEventListener('click', loadRegistrationsTable, { once: true });

  drawLiveNumbers();
  drawRangeSelector();
  drawCharts();

  const unsubscribeAircraft = onChange(drawLiveNumbers);
  const unsubscribeSettings = onSettingsChange(drawLiveNumbers);
  const refreshTimer = setInterval(drawCharts, HISTORY_REFRESH_MS);

  return () => {
    unsubscribeAircraft();
    unsubscribeSettings();
    clearInterval(refreshTimer);
  };
}
