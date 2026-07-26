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
}
