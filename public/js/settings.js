import { t } from './i18n.js';
import { getSettings, updateSettings } from './settings-state.js';

export function renderSettingsPanel(container) {
  const settings = getSettings();

  container.innerHTML = `
    <fieldset class="mlpr-settings-group">
      <legend>${t('units')}</legend>
      <label><input type="radio" name="mlpr-units" value="imperial" ${settings.units === 'imperial' ? 'checked' : ''}> ${t('imperial')}</label>
      <label><input type="radio" name="mlpr-units" value="metric" ${settings.units === 'metric' ? 'checked' : ''}> ${t('metric')}</label>
    </fieldset>

    <fieldset class="mlpr-settings-group">
      <legend>${t('altitudeFilter')}</legend>
      <label>${t('hideBelow')} <input type="number" id="mlpr-alt-min" value="${settings.altitudeFilterMin ?? ''}" step="500"> ft</label>
      <label>${t('hideAbove')} <input type="number" id="mlpr-alt-max" value="${settings.altitudeFilterMax ?? ''}" step="500"> ft</label>
    </fieldset>

    <fieldset class="mlpr-settings-group">
      <legend>${t('layers')}</legend>
      <label><input type="checkbox" id="mlpr-layer-basemap" ${settings.layers.basemap ? 'checked' : ''}> ${t('basemap')}</label>
      <label><input type="checkbox" id="mlpr-layer-trails" ${settings.layers.trails ? 'checked' : ''}> ${t('trails')}</label>
    </fieldset>

    <fieldset class="mlpr-settings-group">
      <legend>${t('homeLocation')}</legend>
      <p id="mlpr-home-status" class="mlpr-home-status">…</p>
      <label>Lat <input type="number" id="mlpr-home-lat" step="0.0001"></label>
      <label>Lon <input type="number" id="mlpr-home-lon" step="0.0001"></label>
      <div class="mlpr-home-actions">
        <button type="button" id="mlpr-home-save">${t('save')}</button>
        <button type="button" id="mlpr-home-reset" style="display:none">${t('resetToAuto')}</button>
      </div>
    </fieldset>
  `;

  for (const input of container.querySelectorAll('input[name="mlpr-units"]')) {
    input.addEventListener('change', (event) => updateSettings({ units: event.target.value }));
  }

  container.querySelector('#mlpr-alt-min').addEventListener('change', (event) => {
    updateSettings({ altitudeFilterMin: event.target.value === '' ? null : Number(event.target.value) });
  });
  container.querySelector('#mlpr-alt-max').addEventListener('change', (event) => {
    updateSettings({ altitudeFilterMax: event.target.value === '' ? null : Number(event.target.value) });
  });

  container.querySelector('#mlpr-layer-basemap').addEventListener('change', (event) => {
    updateSettings({ layers: { ...getSettings().layers, basemap: event.target.checked } });
  });
  container.querySelector('#mlpr-layer-trails').addEventListener('change', (event) => {
    updateSettings({ layers: { ...getSettings().layers, trails: event.target.checked } });
  });

  const homeLatInput = container.querySelector('#mlpr-home-lat');
  const homeLonInput = container.querySelector('#mlpr-home-lon');
  const homeStatusEl = container.querySelector('#mlpr-home-status');
  const homeResetBtn = container.querySelector('#mlpr-home-reset');
  const homeSaveBtn = container.querySelector('#mlpr-home-save');

  async function loadHome() {
    try {
      const response = await fetch('/api/settings');
      const data = await response.json();
      homeLatInput.value = data.homeLat ?? '';
      homeLonInput.value = data.homeLon ?? '';
      homeStatusEl.textContent =
        data.homeSource === 'manual'
          ? t('homeManual')
          : data.homeSource === 'receiver.json'
            ? t('homeAutoDetected')
            : t('homeNotSet');
      homeResetBtn.style.display = data.homeSource === 'manual' ? '' : 'none';
    } catch {
      homeStatusEl.textContent = t('homeNotSet');
    }
  }

  homeSaveBtn.addEventListener('click', async () => {
    const homeLat = Number(homeLatInput.value);
    const homeLon = Number(homeLonInput.value);
    if (!Number.isFinite(homeLat) || !Number.isFinite(homeLon)) return;

    await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ homeLat, homeLon }),
    });
    await loadHome();
  });

  homeResetBtn.addEventListener('click', async () => {
    await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ homeLat: null, homeLon: null }),
    });
    await loadHome();
  });

  loadHome();
}
