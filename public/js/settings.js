import { t } from './i18n.js';
import { getSettings, updateSettings } from './settings-state.js';
import { COMMON_AIRCRAFT_TYPES } from './aircraft-types.js';
import { authorizedFetch, storeToken, clearStoredToken, getStoredToken } from './settings-auth.js';
import { isOnlineFallbackActive } from './basemap.js';

async function authedFetch(container, url, options) {
  const response = await authorizedFetch(url, options);
  if (response.status === 401) {
    clearStoredToken();
    renderSettingsPanel(container);
    return null;
  }
  return response;
}

function renderGate(container, onUnlocked) {
  container.innerHTML = `
    <div class="mlpr-gate">
      <p>${t('settingsLocked')}</p>
      <label>${t('password')} <input type="password" id="mlpr-gate-password"></label>
      <div class="mlpr-home-actions">
        <button type="button" id="mlpr-gate-submit">${t('unlock')}</button>
      </div>
      <p id="mlpr-gate-error" class="mlpr-gate-error"></p>
    </div>
  `;

  const passwordInput = container.querySelector('#mlpr-gate-password');
  const errorEl = container.querySelector('#mlpr-gate-error');

  async function attempt() {
    const response = await fetch('/api/settings-auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: passwordInput.value }),
    });
    if (response.ok) {
      const { token } = await response.json();
      storeToken(token);
      onUnlocked();
    } else {
      errorEl.textContent = t('wrongPassword');
    }
  }

  container.querySelector('#mlpr-gate-submit').addEventListener('click', attempt);
  passwordInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') attempt();
  });
}

export async function renderSettingsPanel(container) {
  let status;
  try {
    status = await fetch('/api/settings-auth/status').then((res) => res.json());
  } catch {
    status = { passwordSet: false };
  }

  if (status.passwordSet && !getStoredToken()) {
    renderGate(container, () => renderSettingsPanel(container));
    return undefined;
  }

  return renderSettingsForm(container);
}

function renderSettingsForm(container) {
  const settings = getSettings();

  container.innerHTML = `
    <div class="mlpr-settings-tabs">
      <button type="button" class="mlpr-settings-tab-btn active" data-tab="general">${t('tabGeneral')}</button>
      <button type="button" class="mlpr-settings-tab-btn" data-tab="map">${t('tabMap')}</button>
      <button type="button" class="mlpr-settings-tab-btn" data-tab="aircraft">${t('tabAircraft')}</button>
      <button type="button" class="mlpr-settings-tab-btn" data-tab="notifications">${t('tabNotifications')}</button>
    </div>

    <div class="mlpr-settings-tab-panel" data-tab-panel="general">
      <fieldset class="mlpr-settings-group">
        <legend>${t('units')}</legend>
        <label><input type="radio" name="mlpr-units" value="imperial" ${settings.units === 'imperial' ? 'checked' : ''}> ${t('imperial')}</label>
        <label><input type="radio" name="mlpr-units" value="metric" ${settings.units === 'metric' ? 'checked' : ''}> ${t('metric')}</label>
      </fieldset>

      <fieldset class="mlpr-settings-group">
        <legend>${t('security')}</legend>
        <p id="mlpr-security-status" class="mlpr-home-status">…</p>
        <div id="mlpr-security-form"></div>
      </fieldset>
    </div>

    <div class="mlpr-settings-tab-panel" data-tab-panel="map" style="display:none">
      <fieldset class="mlpr-settings-group">
        <legend>${t('basemap')}</legend>
        <label><input type="radio" name="mlpr-basemap-mode" value="online" ${settings.basemapMode === 'online' ? 'checked' : ''}> ${t('basemapOnline')}</label>
        <label><input type="radio" name="mlpr-basemap-mode" value="offline" ${settings.basemapMode === 'offline' ? 'checked' : ''}> ${t('basemapOffline')}</label>
        ${
          settings.basemapMode === 'online' && isOnlineFallbackActive()
            ? `<p class="mlpr-home-status">${t('basemapFallbackNotice')}</p>`
            : ''
        }
        <label><input type="checkbox" id="mlpr-layer-basemap" ${settings.layers.basemap ? 'checked' : ''}> ${t('showBasemap')}</label>
      </fieldset>

      <fieldset class="mlpr-settings-group">
        <legend>${t('trails')}</legend>
        <label><input type="checkbox" id="mlpr-trails-enabled" ${settings.trailsEnabled ? 'checked' : ''}> ${t('showTrails')}</label>
        <div id="mlpr-trail-mode-group" style="${settings.trailsEnabled ? '' : 'display:none'}">
          <label><input type="radio" name="mlpr-trail-mode" value="click" ${settings.trailMode === 'click' ? 'checked' : ''}> ${t('trailModeClick')}</label>
          <label><input type="radio" name="mlpr-trail-mode" value="all" ${settings.trailMode === 'all' ? 'checked' : ''}> ${t('trailModeAll')}</label>
        </div>
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
    </div>

    <div class="mlpr-settings-tab-panel" data-tab-panel="aircraft" style="display:none">
      <fieldset class="mlpr-settings-group">
        <legend>${t('altitudeFilter')}</legend>
        <label>${t('hideBelow')} <input type="number" id="mlpr-alt-min" value="${settings.altitudeFilterMin ?? ''}" step="500"> ft</label>
        <label>${t('hideAbove')} <input type="number" id="mlpr-alt-max" value="${settings.altitudeFilterMax ?? ''}" step="500"> ft</label>
      </fieldset>

      <fieldset class="mlpr-settings-group">
        <legend>${t('watchlist')}</legend>
        <div id="mlpr-watchlist-items"></div>
        <div class="mlpr-watch-form">
          <select id="mlpr-watch-type">
            <option value="type">${t('watchType')}</option>
            <option value="registration">${t('watchRegistration')}</option>
            <option value="flight">${t('watchFlight')}</option>
          </select>
          <input type="text" id="mlpr-watch-value" list="mlpr-aircraft-types" placeholder="${t('watchValuePlaceholder')}">
          <datalist id="mlpr-aircraft-types">
            ${COMMON_AIRCRAFT_TYPES.map((code) => `<option value="${code}">`).join('')}
          </datalist>
          <select id="mlpr-watch-alt-op">
            <option value="">${t('noAltitudeCondition')}</option>
            <option value="below">${t('below')}</option>
            <option value="above">${t('above')}</option>
          </select>
          <input type="number" id="mlpr-watch-alt-value" placeholder="ft" style="display:none">
          <button type="button" id="mlpr-watch-add">${t('add')}</button>
        </div>
        <p id="mlpr-watch-error" class="mlpr-gate-error"></p>
      </fieldset>
    </div>

    <div class="mlpr-settings-tab-panel" data-tab-panel="notifications" style="display:none">
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
    </div>
  `;

  wireTabs(container);
  wireDisplaySettings(container);
  wireHomeLocation(container);
  wireNotificationSettings(container);
  wireWatchlist(container);
  renderSecuritySection(container);

  return undefined;
}

function wireTabs(container) {
  const buttons = container.querySelectorAll('.mlpr-settings-tab-btn');
  const panels = container.querySelectorAll('.mlpr-settings-tab-panel');

  for (const btn of buttons) {
    btn.addEventListener('click', () => {
      for (const b of buttons) b.classList.toggle('active', b === btn);
      for (const panel of panels) {
        panel.style.display = panel.dataset.tabPanel === btn.dataset.tab ? '' : 'none';
      }
    });
  }
}

function wireDisplaySettings(container) {
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

  for (const input of container.querySelectorAll('input[name="mlpr-basemap-mode"]')) {
    input.addEventListener('change', (event) => updateSettings({ basemapMode: event.target.value }));
  }

  const trailsEnabledEl = container.querySelector('#mlpr-trails-enabled');
  const trailModeGroup = container.querySelector('#mlpr-trail-mode-group');
  trailsEnabledEl.addEventListener('change', (event) => {
    updateSettings({ trailsEnabled: event.target.checked });
    trailModeGroup.style.display = event.target.checked ? '' : 'none';
  });
  for (const input of container.querySelectorAll('input[name="mlpr-trail-mode"]')) {
    input.addEventListener('change', (event) => updateSettings({ trailMode: event.target.value }));
  }
}

function wireHomeLocation(container) {
  const homeLatInput = container.querySelector('#mlpr-home-lat');
  const homeLonInput = container.querySelector('#mlpr-home-lon');
  const homeStatusEl = container.querySelector('#mlpr-home-status');
  const homeResetBtn = container.querySelector('#mlpr-home-reset');
  const homeSaveBtn = container.querySelector('#mlpr-home-save');

  async function loadHome() {
    const response = await authedFetch(container, '/api/settings');
    if (!response) return;
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
  }

  homeSaveBtn.addEventListener('click', async () => {
    const homeLat = Number(homeLatInput.value);
    const homeLon = Number(homeLonInput.value);
    if (!Number.isFinite(homeLat) || !Number.isFinite(homeLon)) return;

    const response = await authedFetch(container, '/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ homeLat, homeLon }),
    });
    if (!response) return;
    await loadHome();
  });

  homeResetBtn.addEventListener('click', async () => {
    const response = await authedFetch(container, '/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ homeLat: null, homeLon: null }),
    });
    if (!response) return;
    await loadHome();
  });

  loadHome();
}

function wireNotificationSettings(container) {
  const notifSquawkEl = container.querySelector('#mlpr-notif-squawk');
  const notif7500El = container.querySelector('#mlpr-notif-squawk-7500');
  const notif7600El = container.querySelector('#mlpr-notif-squawk-7600');
  const notif7700El = container.querySelector('#mlpr-notif-squawk-7700');
  const notifFirstSeenEl = container.querySelector('#mlpr-notif-firstseen');
  const notifRangeRecordEl = container.querySelector('#mlpr-notif-rangerecord');
  const ntfyTopicEl = container.querySelector('#mlpr-ntfy-topic');
  const ntfyRegenerateBtn = container.querySelector('#mlpr-ntfy-regenerate');

  async function loadNotificationSettings() {
    const response = await authedFetch(container, '/api/notifications/settings');
    if (!response) return;
    const data = await response.json();
    notifSquawkEl.checked = data.squawkEnabled;
    notif7500El.checked = data.squawkCodes['7500'];
    notif7600El.checked = data.squawkCodes['7600'];
    notif7700El.checked = data.squawkCodes['7700'];
    notifFirstSeenEl.checked = data.firstSeenEnabled;
    notifRangeRecordEl.checked = data.rangeRecordEnabled;
  }

  async function putNotificationSettings(patch) {
    await authedFetch(container, '/api/notifications/settings', {
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
    const response = await authedFetch(container, '/api/notifications/ntfy-topic');
    if (!response) return;
    const data = await response.json();
    ntfyTopicEl.textContent = data.topic;
  }

  ntfyRegenerateBtn.addEventListener('click', async () => {
    const response = await authedFetch(container, '/api/notifications/ntfy-topic/regenerate', { method: 'POST' });
    if (!response) return;
    const data = await response.json();
    ntfyTopicEl.textContent = data.topic;
  });

  loadNotificationSettings();
  loadNtfyTopic();
}

function watchEntryLabel(entry) {
  const typeLabel = { type: t('watchType'), registration: t('watchRegistration'), flight: t('watchFlight') }[
    entry.matchType
  ];
  let text = `${typeLabel}: ${entry.matchValue}`;
  if (entry.altitudeOperator) {
    text += ` (${entry.altitudeOperator === 'below' ? t('below') : t('above')} ${entry.altitudeValue} ft)`;
  }
  return text;
}

function wireWatchlist(container) {
  const itemsEl = container.querySelector('#mlpr-watchlist-items');
  const typeSelect = container.querySelector('#mlpr-watch-type');
  const valueInput = container.querySelector('#mlpr-watch-value');
  const altOpSelect = container.querySelector('#mlpr-watch-alt-op');
  const altValueInput = container.querySelector('#mlpr-watch-alt-value');
  const addBtn = container.querySelector('#mlpr-watch-add');
  const errorEl = container.querySelector('#mlpr-watch-error');

  typeSelect.addEventListener('change', () => {
    if (typeSelect.value === 'type') {
      valueInput.setAttribute('list', 'mlpr-aircraft-types');
    } else {
      valueInput.removeAttribute('list');
    }
  });

  altOpSelect.addEventListener('change', () => {
    altValueInput.style.display = altOpSelect.value ? '' : 'none';
  });

  async function loadWatchlist() {
    const response = await authedFetch(container, '/api/notifications/watchlist');
    if (!response) return;
    const entries = await response.json();

    itemsEl.innerHTML = '';
    for (const entry of entries) {
      const row = document.createElement('div');
      row.className = 'mlpr-watch-row';
      const label = document.createElement('span');
      label.textContent = watchEntryLabel(entry);
      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.textContent = t('remove');
      removeBtn.addEventListener('click', async () => {
        const deleteResponse = await authedFetch(container, `/api/notifications/watchlist/${entry.id}`, {
          method: 'DELETE',
        });
        if (!deleteResponse) return;
        await loadWatchlist();
      });
      row.append(label, removeBtn);
      itemsEl.appendChild(row);
    }
  }

  addBtn.addEventListener('click', async () => {
    errorEl.textContent = '';
    const body = {
      matchType: typeSelect.value,
      matchValue: valueInput.value,
      altitudeOperator: altOpSelect.value || null,
      altitudeValue: altOpSelect.value ? Number(altValueInput.value) : null,
    };

    const response = await authedFetch(container, '/api/notifications/watchlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response) return;

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      errorEl.textContent = data.error ?? t('somethingWentWrong');
      return;
    }

    valueInput.value = '';
    altOpSelect.value = '';
    altValueInput.value = '';
    altValueInput.style.display = 'none';
    await loadWatchlist();
  });

  loadWatchlist();
}

async function renderSecuritySection(container) {
  const statusEl = container.querySelector('#mlpr-security-status');
  const formEl = container.querySelector('#mlpr-security-form');

  let status;
  try {
    status = await fetch('/api/settings-auth/status').then((res) => res.json());
  } catch {
    status = { passwordSet: false };
  }

  statusEl.textContent = status.passwordSet ? t('passwordIsSet') : t('passwordNotSet');

  formEl.innerHTML = status.passwordSet
    ? `
      <button type="button" id="mlpr-security-toggle">${t('changePassword')}</button>
      <div id="mlpr-security-fields" style="display:none">
        <label>${t('currentPassword')} <input type="password" id="mlpr-security-current"></label>
        <label>${t('newPasswordOptional')} <input type="password" id="mlpr-security-new"></label>
        <div class="mlpr-home-actions">
          <button type="button" id="mlpr-security-save">${t('save')}</button>
        </div>
        <p id="mlpr-security-error" class="mlpr-gate-error"></p>
      </div>
    `
    : `
      <button type="button" id="mlpr-security-toggle">${t('securePasswordButton')}</button>
      <div id="mlpr-security-fields" style="display:none">
        <label>${t('newPassword')} <input type="password" id="mlpr-security-new"></label>
        <div class="mlpr-home-actions">
          <button type="button" id="mlpr-security-save">${t('save')}</button>
        </div>
        <p id="mlpr-security-error" class="mlpr-gate-error"></p>
      </div>
    `;

  const fieldsEl = formEl.querySelector('#mlpr-security-fields');
  formEl.querySelector('#mlpr-security-toggle').addEventListener('click', () => {
    fieldsEl.style.display = fieldsEl.style.display === 'none' ? '' : 'none';
  });

  formEl.querySelector('#mlpr-security-save').addEventListener('click', async () => {
    const newPassword = formEl.querySelector('#mlpr-security-new').value || null;
    const currentPasswordInput = formEl.querySelector('#mlpr-security-current');
    const currentPassword = currentPasswordInput ? currentPasswordInput.value : undefined;
    const errorEl = formEl.querySelector('#mlpr-security-error');

    const response = await fetch('/api/settings-auth/password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ newPassword, currentPassword }),
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      errorEl.textContent = data.error ?? t('somethingWentWrong');
      return;
    }

    if (data.token) storeToken(data.token);
    if (!data.passwordSet) clearStoredToken();

    renderSecuritySection(container);
  });
}
