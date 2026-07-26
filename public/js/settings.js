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

    <fieldset class="mlpr-settings-group">
      <legend>${t('notifications')}</legend>
      <label><input type="checkbox" id="mlpr-notif-squawk"> ${t('squawkAlerts')}</label>
      <div class="mlpr-notif-squawk-codes">
        <label><input type="checkbox" id="mlpr-notif-squawk-7500"> 7500</label>
        <label><input type="checkbox" id="mlpr-notif-squawk-7600"> 7600</label>
        <label><input type="checkbox" id="mlpr-notif-squawk-7700"> 7700</label>
      </div>
      <label><input type="checkbox" id="mlpr-notif-firstseen"> ${t('firstSeen')}</label>
      <label><input type="checkbox" id="mlpr-notif-rangerecord"> ${t('rangeRecord')}</label>
      <p class="mlpr-home-status">${t('ntfyInstructions')}</p>
      <p class="mlpr-ntfy-topic" id="mlpr-ntfy-topic">…</p>
      <div class="mlpr-home-actions">
        <button type="button" id="mlpr-ntfy-regenerate">${t('regenerateTopic')}</button>
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

  const notifSquawkEl = container.querySelector('#mlpr-notif-squawk');
  const notif7500El = container.querySelector('#mlpr-notif-squawk-7500');
  const notif7600El = container.querySelector('#mlpr-notif-squawk-7600');
  const notif7700El = container.querySelector('#mlpr-notif-squawk-7700');
  const notifFirstSeenEl = container.querySelector('#mlpr-notif-firstseen');
  const notifRangeRecordEl = container.querySelector('#mlpr-notif-rangerecord');
  const ntfyTopicEl = container.querySelector('#mlpr-ntfy-topic');
  const ntfyRegenerateBtn = container.querySelector('#mlpr-ntfy-regenerate');

  async function loadNotificationSettings() {
    const response = await fetch('/api/notifications/settings');
    const data = await response.json();
    notifSquawkEl.checked = data.squawkEnabled;
    notif7500El.checked = data.squawkCodes['7500'];
    notif7600El.checked = data.squawkCodes['7600'];
    notif7700El.checked = data.squawkCodes['7700'];
    notifFirstSeenEl.checked = data.firstSeenEnabled;
    notifRangeRecordEl.checked = data.rangeRecordEnabled;
  }

  async function putNotificationSettings(patch) {
    await fetch('/api/notifications/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
  }

  notifSquawkEl.addEventListener('change', (event) => putNotificationSettings({ squawkEnabled: event.target.checked }));
  notif7500El.addEventListener('change', (event) => putNotificationSettings({ squawkCodes: { 7500: event.target.checked } }));
  notif7600El.addEventListener('change', (event) => putNotificationSettings({ squawkCodes: { 7600: event.target.checked } }));
  notif7700El.addEventListener('change', (event) => putNotificationSettings({ squawkCodes: { 7700: event.target.checked } }));
  notifFirstSeenEl.addEventListener('change', (event) =>
    putNotificationSettings({ firstSeenEnabled: event.target.checked }),
  );
  notifRangeRecordEl.addEventListener('change', (event) =>
    putNotificationSettings({ rangeRecordEnabled: event.target.checked }),
  );

  async function loadNtfyTopic() {
    const response = await fetch('/api/notifications/ntfy-topic');
    const data = await response.json();
    ntfyTopicEl.textContent = data.topic;
  }

  ntfyRegenerateBtn.addEventListener('click', async () => {
    const response = await fetch('/api/notifications/ntfy-topic/regenerate', { method: 'POST' });
    const data = await response.json();
    ntfyTopicEl.textContent = data.topic;
  });

  loadNotificationSettings();
  loadNtfyTopic();
}
