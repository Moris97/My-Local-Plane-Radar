import { t } from './i18n.js';
import { getLiveStats, onChange } from './radar-state.js';
import { getSettings, onSettingsChange } from './settings-state.js';
import { renderSparklineSvg } from './chart.js';
import { formatDistance } from './units.js';

const HISTORY_REFRESH_MS = 20000;

async function fetchHistory() {
  try {
    const response = await fetch('/api/stats/history');
    if (!response.ok) return [];
    return await response.json();
  } catch {
    return [];
  }
}

export function renderStatsPanel(container) {
  container.innerHTML = `
    <dl class="mlpr-stats">
      <dt>${t('aircraftCount')}</dt><dd id="mlpr-stat-count">0</dd>
      <dt>${t('messagesPerSecond')}</dt><dd id="mlpr-stat-rate">–</dd>
      <dt>${t('maxRange')}</dt><dd id="mlpr-stat-range">–</dd>
    </dl>
    <p class="mlpr-chart-label">${t('aircraftHistory')}</p>
    <div id="mlpr-chart-aircraft"></div>
    <p class="mlpr-chart-label">${t('messagesHistory')}</p>
    <div id="mlpr-chart-messages"></div>
  `;

  const countEl = container.querySelector('#mlpr-stat-count');
  const rateEl = container.querySelector('#mlpr-stat-rate');
  const rangeEl = container.querySelector('#mlpr-stat-range');
  const aircraftChartEl = container.querySelector('#mlpr-chart-aircraft');
  const messagesChartEl = container.querySelector('#mlpr-chart-messages');

  function drawLiveNumbers() {
    const stats = getLiveStats();
    const { units } = getSettings();
    countEl.textContent = String(stats.aircraftCount ?? 0);
    rateEl.textContent = typeof stats.messagesPerSec === 'number' ? stats.messagesPerSec.toFixed(1) : '–';
    rangeEl.textContent = formatDistance(stats.maxRangeKm, units) ?? '–';
  }

  async function drawCharts() {
    const history = await fetchHistory();
    aircraftChartEl.innerHTML = renderSparklineSvg(history.map((sample) => sample.aircraftCount));
    messagesChartEl.innerHTML = renderSparklineSvg(history.map((sample) => sample.messagesPerMinute), {
      color: '#3d8bdc',
    });
  }

  drawLiveNumbers();
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
