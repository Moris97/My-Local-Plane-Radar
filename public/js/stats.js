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

const RANGES = ['24h', '7d', '31d', '1y', 'all'];
const RANGE_LABEL_KEYS = {
  '24h': 'statsRange24h',
  '7d': 'statsRange7d',
  '31d': 'statsRange31d',
  '1y': 'statsRange1y',
  all: 'statsRangeAll',
};

// Not persisted -- resets to the confirmed default ("since the beginning")
// on every fresh page load, but keeps whatever the user picked for as long
// as the tab stays open (switching to another panel and back to Stats
// doesn't reset it).
let currentRange = 'all';

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
      <button type="button" id="mlpr-load-registrations" class="mlpr-detail-expand">${t('showRegistrations')}</button>
      <div id="mlpr-registrations-table"></div>
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

  async function loadRegistrationsTable() {
    const tableEl = container.querySelector('#mlpr-registrations-table');
    const loadBtn = container.querySelector('#mlpr-load-registrations');
    loadBtn.remove();

    const [airlines, registrations] = await Promise.all([getAirlinesMap(), fetchJson('/api/stats/registrations', [])]);

    let sortKey = 'lastSeenAt';
    let sortAsc = false;

    function draw() {
      if (registrations.length === 0) {
        tableEl.innerHTML = `<p class="mlpr-empty">${t('noStatsData')}</p>`;
        return;
      }
      const rows = [...registrations].sort((a, b) => {
        const cmp = String(a[sortKey] ?? '').localeCompare(String(b[sortKey] ?? ''), undefined, { numeric: true });
        return sortAsc ? cmp : -cmp;
      });

      tableEl.innerHTML = `
        <table class="mlpr-list-table">
          <thead><tr>${REGISTRATIONS_COLUMNS.map((col) => `<th data-key="${col.key}">${col.label()}</th>`).join('')}</tr></thead>
          <tbody>${rows.map((r) => watchEntryRowHtml(r, airlines)).join('')}</tbody>
        </table>`;

      for (const th of tableEl.querySelectorAll('th')) {
        th.addEventListener('click', () => {
          if (sortKey === th.dataset.key) {
            sortAsc = !sortAsc;
          } else {
            sortKey = th.dataset.key;
            sortAsc = true;
          }
          draw();
        });
      }
    }

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
