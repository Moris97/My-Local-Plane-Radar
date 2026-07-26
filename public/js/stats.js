import { t } from './i18n.js';
import { getLiveAircraft, getMessagesCounter, onChange } from './radar-state.js';

let lastCounter = null;
let currentRate = null;

export function renderStatsPanel(container) {
  container.innerHTML = `
    <dl class="mlpr-stats">
      <dt>${t('aircraftCount')}</dt><dd id="mlpr-stat-count">0</dd>
      <dt>${t('messagesPerSecond')}</dt><dd id="mlpr-stat-rate">–</dd>
    </dl>
  `;

  const countEl = container.querySelector('#mlpr-stat-count');
  const rateEl = container.querySelector('#mlpr-stat-rate');

  function draw() {
    countEl.textContent = String(getLiveAircraft().length);

    const counter = getMessagesCounter();
    if (counter && lastCounter && counter.atMs > lastCounter.atMs) {
      const deltaValue = counter.value - lastCounter.value;
      const deltaTime = (counter.atMs - lastCounter.atMs) / 1000;
      if (deltaTime > 0 && deltaValue >= 0) {
        currentRate = deltaValue / deltaTime;
      }
    }
    lastCounter = counter;

    rateEl.textContent = currentRate === null ? '–' : currentRate.toFixed(1);
  }

  draw();
  return onChange(draw);
}
