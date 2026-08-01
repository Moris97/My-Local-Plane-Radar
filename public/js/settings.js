import { t } from './i18n.js';
import { getSettings, updateSettings, ICON_SIZE_MIN, ICON_SIZE_MAX } from './settings-state.js';
import { COMMON_AIRCRAFT_TYPES } from './aircraft-types.js';
import { authorizedFetch, storeToken, clearStoredToken, getStoredToken } from './settings-auth.js';
import { isOnlineFallbackActive } from './basemap.js';
import { formatDistance } from './units.js';
import { openAreaEditor } from './area-editor.js';

// Mirrors server/src/antenna-stats.js's ALTITUDE_BANDS, index for index --
// only the translated label text lives here, the actual band boundaries are
// server-side (this is display-only, never sent anywhere; the index itself
// is what's sent as ?band=).
const COVERAGE_BAND_LABEL_KEYS = [
  'coverageBand0', 'coverageBand1', 'coverageBand2', 'coverageBand3', 'coverageBand4',
  'coverageBand5', 'coverageBand6', 'coverageBand7', 'coverageBand8',
];

// Used only within the Server tab (see renderServerTab) -- everything else
// no longer requires a token, so nothing else needs to react to a 401.
async function authedFetch(url, options, onUnauthorized) {
  const response = await authorizedFetch(url, options);
  if (response.status === 401) {
    clearStoredToken();
    onUnauthorized();
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
    } else if (response.status === 429) {
      errorEl.textContent = t('tooManyAttempts');
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
      <button type="button" class="mlpr-settings-tab-btn" data-tab="server">${t('tabServer')}</button>
    </div>

    <div class="mlpr-settings-tab-panel" data-tab-panel="general">
      <p class="mlpr-scope-note">${t('scopeLocal')}</p>
      <fieldset class="mlpr-settings-group">
        <legend>${t('units')}</legend>
        <label><input type="radio" name="mlpr-units" value="imperial" ${settings.units === 'imperial' ? 'checked' : ''}> ${t('imperial')}</label>
        <label><input type="radio" name="mlpr-units" value="metric" ${settings.units === 'metric' ? 'checked' : ''}> ${t('metric')}</label>
      </fieldset>

      <fieldset class="mlpr-settings-group">
        <legend>${t('language')}</legend>
        <label>
          <select id="mlpr-language">
            <option value="auto" ${settings.language === 'auto' ? 'selected' : ''}>${t('languageAuto')}</option>
            <option value="en" ${settings.language === 'en' ? 'selected' : ''}>English</option>
            <option value="pl" ${settings.language === 'pl' ? 'selected' : ''}>Polski</option>
          </select>
        </label>
      </fieldset>
    </div>

    <div class="mlpr-settings-tab-panel" data-tab-panel="map" style="display:none">
      <p class="mlpr-scope-note">${t('scopeLocal')}</p>
      <fieldset class="mlpr-settings-group">
        <legend>${t('basemap')}</legend>
        <label><input type="radio" name="mlpr-basemap-mode" value="online" ${settings.basemapMode === 'online' ? 'checked' : ''}> ${t('basemapOnline')}</label>
        <label><input type="radio" name="mlpr-basemap-mode" value="offline" ${settings.basemapMode === 'offline' ? 'checked' : ''}> ${t('basemapOffline')}</label>
        ${
          settings.basemapMode === 'online' && isOnlineFallbackActive()
            ? `<p class="mlpr-home-status">${t('basemapFallbackNotice')}</p>`
            : ''
        }
      </fieldset>

      <fieldset class="mlpr-settings-group">
        <legend>${t('mapAppearance')}</legend>
        <label><input type="radio" name="mlpr-map-theme" value="light" ${settings.mapTheme === 'light' ? 'checked' : ''}> ${t('mapThemeLight')}</label>
        <label><input type="radio" name="mlpr-map-theme" value="dark" ${settings.mapTheme === 'dark' ? 'checked' : ''}> ${t('mapThemeDark')}</label>
        <div class="mlpr-checkbox-row">
          <label><input type="radio" name="mlpr-map-theme" value="auto" ${settings.mapTheme === 'auto' ? 'checked' : ''}> ${t('mapThemeAuto')}</label>
          <button type="button" class="mlpr-info-icon">i<span class="mlpr-tooltip">${t('mapThemeAutoHint')}</span></button>
        </div>
      </fieldset>

      <fieldset class="mlpr-settings-group">
        <legend>${t('trails')}</legend>
        <label><input type="radio" name="mlpr-trail-mode" value="click" ${settings.trailMode === 'click' ? 'checked' : ''}> ${t('trailModeClick')}</label>
        <label><input type="radio" name="mlpr-trail-mode" value="all" ${settings.trailMode === 'all' ? 'checked' : ''}> ${t('trailModeAll')}</label>
        <div class="mlpr-checkbox-row">
          <label><input type="checkbox" id="mlpr-shorter-trails" ${settings.shorterTrails ? 'checked' : ''}> ${t('shorterTrails')}</label>
          <button type="button" class="mlpr-info-icon">i<span class="mlpr-tooltip">${t('shorterTrailsHint')}</span></button>
        </div>
      </fieldset>

      <fieldset class="mlpr-settings-group">
        <legend>${t('homeMarker')}</legend>
        <label><input type="checkbox" id="mlpr-show-home-marker" ${settings.showHomeMarker ? 'checked' : ''}> ${t('showHomeMarker')}</label>
      </fieldset>

      <fieldset class="mlpr-settings-group">
        <legend>${t('coverage')}</legend>
        <div class="mlpr-checkbox-row">
          <label><input type="checkbox" id="mlpr-show-coverage" ${settings.showCoverage ? 'checked' : ''}> ${t('showCoverage')}</label>
          <button type="button" class="mlpr-info-icon">i<span class="mlpr-tooltip">${t('showCoverageHint')}</span></button>
        </div>
        <label>${t('coverageBand')}
          <select id="mlpr-coverage-band">
            <option value="all" ${settings.coverageBand === 'all' ? 'selected' : ''}>${t('coverageBandAll')}</option>
            ${COVERAGE_BAND_LABEL_KEYS.map(
              (key, i) => `<option value="${i}" ${settings.coverageBand === i ? 'selected' : ''}>${t(key)}</option>`,
            ).join('')}
          </select>
        </label>
      </fieldset>

    </div>

    <div class="mlpr-settings-tab-panel" data-tab-panel="aircraft" style="display:none">
      <p class="mlpr-scope-note">${t('scopeLocal')}</p>
      <fieldset class="mlpr-settings-group">
        <legend>${t('appearance')}</legend>
        <label class="mlpr-slider-label">
          ${t('iconSize')}
          <span id="mlpr-icon-size-value">${settings.aircraftIconSize}px</span>
        </label>
        <input type="range" id="mlpr-icon-size" min="${ICON_SIZE_MIN}" max="${ICON_SIZE_MAX}" step="2" value="${settings.aircraftIconSize}">
        <div class="mlpr-radio-group">
          <span class="mlpr-radio-group-label">${t('planeColorMode')}</span>
          <label><input type="radio" name="mlpr-plane-color-mode" value="signalLoss" ${settings.planeColorMode === 'signalLoss' ? 'checked' : ''}> ${t('planeColorModeSignalLoss')}</label>
          <label><input type="radio" name="mlpr-plane-color-mode" value="altitude" ${settings.planeColorMode === 'altitude' ? 'checked' : ''}> ${t('planeColorModeAltitude')}</label>
          <label><input type="radio" name="mlpr-plane-color-mode" value="speed" ${settings.planeColorMode === 'speed' ? 'checked' : ''}> ${t('planeColorModeSpeed')}</label>
        </div>
      </fieldset>

      <fieldset class="mlpr-settings-group">
        <legend>${t('mapLabels')}</legend>
        <p class="mlpr-home-status">${t('mapLabelsHint')}</p>
        <label><input type="checkbox" id="mlpr-label-flight" ${settings.aircraftLabelFields.flight ? 'checked' : ''}> ${t('labelFieldFlight')}</label>
        <label><input type="checkbox" id="mlpr-label-type" ${settings.aircraftLabelFields.type ? 'checked' : ''}> ${t('labelFieldType')}</label>
        <label><input type="checkbox" id="mlpr-label-altitude" ${settings.aircraftLabelFields.altitude ? 'checked' : ''}> ${t('labelFieldAltitude')}</label>
        <label><input type="checkbox" id="mlpr-label-speed" ${settings.aircraftLabelFields.speed ? 'checked' : ''}> ${t('labelFieldSpeed')}</label>
      </fieldset>

      <fieldset class="mlpr-settings-group">
        <legend>${t('altitudeFilter')}</legend>
        <label>${t('hideBelow')} <input type="number" id="mlpr-alt-min" value="${settings.altitudeFilterMin ?? ''}" step="500"> ft</label>
        <label>${t('hideAbove')} <input type="number" id="mlpr-alt-max" value="${settings.altitudeFilterMax ?? ''}" step="500"> ft</label>
      </fieldset>

      <fieldset class="mlpr-settings-group">
        <legend>${t('photos')}</legend>
        <div class="mlpr-checkbox-row">
          <label><input type="checkbox" id="mlpr-fetch-photos" ${settings.fetchAircraftPhotos ? 'checked' : ''}> ${t('fetchAircraftPhotos')}</label>
          <button type="button" class="mlpr-info-icon">i<span class="mlpr-tooltip">${t('fetchAircraftPhotosHint')}</span></button>
        </div>
      </fieldset>

    </div>

    <div class="mlpr-settings-tab-panel" data-tab-panel="notifications" style="display:none">
      <!-- Two views sharing this tab: the rule toggles ("what do I want to
           be notified about"), and a subview for the fuller configuration
           behind either of the two buttons. Same display:none swap the tab
           panels themselves use -- no separate panel/modal machinery. The
           Smart Home tab used to be a seventh top-level tab; folding it in
           here is what brings the tab row back to five, which is what the
           .mlpr-settings-tabs layout was sized for in the first place. -->
      <div id="mlpr-notif-main">
        <p class="mlpr-scope-note">${t('scopeGlobal')}</p>
        <fieldset class="mlpr-settings-group">
          <legend>${t('notifications')}</legend>
          <label><input type="checkbox" id="mlpr-notif-squawk"> ${t('squawkAlerts')}</label>
          <div class="mlpr-notif-squawk-codes">
            <label><input type="checkbox" id="mlpr-notif-squawk-7500"> 7500</label>
            <label><input type="checkbox" id="mlpr-notif-squawk-7600"> 7600</label>
            <label><input type="checkbox" id="mlpr-notif-squawk-7700"> 7700</label>
          </div>
          <label><input type="checkbox" id="mlpr-notif-firstseen"> ${t('firstSeen')}</label>
          <label><input type="checkbox" id="mlpr-notif-watched"> ${t('watchlist')}</label>
          <label><input type="checkbox" id="mlpr-notif-rangerecord"> ${t('rangeRecord')}</label>
        </fieldset>

        <!-- Directly under the "Watched aircraft" toggle it configures,
             deliberately on this main view rather than behind "Configure
             notifications" (which holds ntfy *delivery* settings only) --
             the list is what that checkbox actually means, so hiding it a
             click away separated a toggle from its own subject. -->
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
            <button type="button" id="mlpr-watch-area">${t('setArea')}</button>
            <button type="button" id="mlpr-watch-add">${t('add')}</button>
          </div>
          <p id="mlpr-watch-area-summary" class="mlpr-home-status"></p>
          <p id="mlpr-watch-error" class="mlpr-gate-error"></p>
        </fieldset>

        <div class="mlpr-notif-config-actions">
          <button type="button" id="mlpr-notif-configure">${t('configureNotifications')}</button>
          <button type="button" id="mlpr-smarthome-configure">${t('configureSmartHome')}</button>
        </div>
      </div>
      <div id="mlpr-notif-subview" style="display:none"></div>
    </div>

    <div class="mlpr-settings-tab-panel" data-tab-panel="server" style="display:none">
      <p class="mlpr-scope-note">${t('scopeGlobal')}</p>
      <div id="mlpr-server-tab-root">…</div>
    </div>
  `;

  wireTabs(container);
  wireDisplaySettings(container);
  wireNotificationToggles(container);
  wireWatchlist(container);
  wireNotificationSubviews(container);
  renderServerTab(container.querySelector('#mlpr-server-tab-root'));

  return undefined;
}

// Both "Configure ..." buttons open into the same subview container,
// replacing the toggles in place (not stacking on top of them) with a Back
// button in a small header. Deliberately NOT list.js's floating-window
// machinery -- that exists because List's Configure has to sit *beside* a
// live-updating table without disturbing it; nothing here updates while
// you're editing, so an in-place swap is both simpler and identical on
// mobile and desktop.
function wireNotificationSubviews(container) {
  const mainEl = container.querySelector('#mlpr-notif-main');
  const subviewEl = container.querySelector('#mlpr-notif-subview');

  function closeSubview() {
    subviewEl.style.display = 'none';
    subviewEl.innerHTML = '';
    mainEl.style.display = '';
  }

  function openSubview(titleText, renderContent) {
    mainEl.style.display = 'none';
    subviewEl.style.display = '';
    subviewEl.innerHTML = `
      <div class="mlpr-subview-header">
        <button type="button" class="mlpr-subview-back" id="mlpr-subview-back">← ${t('back')}</button>
        <span class="mlpr-subview-title">${titleText}</span>
      </div>
      <div id="mlpr-subview-body"></div>
    `;
    subviewEl.querySelector('#mlpr-subview-back').addEventListener('click', closeSubview);
    renderContent(subviewEl.querySelector('#mlpr-subview-body'));
  }

  container
    .querySelector('#mlpr-notif-configure')
    .addEventListener('click', () => openSubview(t('configureNotifications'), renderNotificationsConfig));
  container
    .querySelector('#mlpr-smarthome-configure')
    // Still gated by requireSettingsAuth exactly as when this was its own
    // tab -- renderSmartHomeTab does its own password check internally, so
    // moving it into a subview doesn't widen who can read broker
    // credentials. The rest of this tab (rule toggles, ntfy topic, watch
    // list) stays deliberately ungated, same split as before.
    .addEventListener('click', () => openSubview(t('configureSmartHome'), renderSmartHomeTab));
}

// Notification *delivery* settings -- currently just the ntfy topic. The
// watch list deliberately does NOT live here: it belongs next to the
// "Watched aircraft" toggle on the main view, since it's what that toggle
// actually means. This subview is about how notifications reach you, not
// what triggers them.
function renderNotificationsConfig(root) {
  root.innerHTML = `
    <fieldset class="mlpr-settings-group">
      <legend>ntfy</legend>
      <p class="mlpr-home-status">${t('ntfyInstructions')}</p>
      <p class="mlpr-ntfy-topic" id="mlpr-ntfy-topic">…</p>
      <div class="mlpr-home-actions">
        <button type="button" id="mlpr-ntfy-regenerate">${t('regenerateTopic')}</button>
      </div>
    </fieldset>
  `;

  wireNtfySection(root);
}

// Settings password gates this tab's content specifically (server port,
// receiver location, and the password form itself) -- not the whole Settings
// panel, unlike the earlier design. Everything else (units, map, aircraft
// display, notification rules, watch list) is per-browser or harmless to
// read/change without a login, so gating the entire panel just made routine
// use annoying for no security benefit; the only things actually worth
// hiding from an unauthorized LAN user are the server-level controls here.
async function renderServerTab(root) {
  let status;
  try {
    status = await fetch('/api/settings-auth/status').then((res) => res.json());
  } catch {
    status = { passwordSet: false };
  }

  if (status.passwordSet && !getStoredToken()) {
    renderGate(root, () => renderServerTab(root));
    return;
  }

  root.innerHTML = `
    <fieldset class="mlpr-settings-group">
      <legend>${t('security')}</legend>
      <p id="mlpr-security-status" class="mlpr-home-status">…</p>
      <div id="mlpr-security-form"></div>
    </fieldset>

    <fieldset class="mlpr-settings-group">
      <legend>${t('serverPort')}</legend>
      <p class="mlpr-home-status">${t('serverPortHint')}</p>
      <label>${t('port')} <input type="number" id="mlpr-server-port" min="1024" max="65535" step="1"></label>
      <div class="mlpr-home-actions">
        <button type="button" id="mlpr-server-port-save">${t('save')}</button>
      </div>
      <p id="mlpr-server-port-status" class="mlpr-home-status"></p>
      <p id="mlpr-server-port-error" class="mlpr-gate-error"></p>
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
      <legend>${t('configBackup')}</legend>
      <p class="mlpr-home-status">${t('configBackupHint')}</p>
      <div class="mlpr-home-actions">
        <button type="button" id="mlpr-config-export">${t('downloadBackup')}</button>
        <button type="button" id="mlpr-config-import-btn">${t('restoreBackup')}</button>
        <input type="file" id="mlpr-config-import-file" accept="application/json" style="display:none">
      </div>
      <p id="mlpr-config-backup-status" class="mlpr-home-status"></p>
      <p id="mlpr-config-backup-error" class="mlpr-gate-error"></p>
    </fieldset>
  `;

  const onUnauthorized = () => renderServerTab(root);
  wireServerPort(root, onUnauthorized);
  wireHomeLocation(root, onUnauthorized);
  wireConfigBackup(root, onUnauthorized);
  renderSecuritySection(root);
}

function wireConfigBackup(container, onUnauthorized) {
  const exportBtn = container.querySelector('#mlpr-config-export');
  const importBtn = container.querySelector('#mlpr-config-import-btn');
  const fileInput = container.querySelector('#mlpr-config-import-file');
  const statusEl = container.querySelector('#mlpr-config-backup-status');
  const errorEl = container.querySelector('#mlpr-config-backup-error');

  exportBtn.addEventListener('click', async () => {
    statusEl.textContent = '';
    errorEl.textContent = '';
    const response = await authedFetch('/api/settings/export', undefined, onUnauthorized);
    if (!response) return;
    if (!response.ok) {
      errorEl.textContent = t('configExportError');
      return;
    }
    const dump = await response.json();
    // Plain client-side "download this JSON as a file" -- a Blob + a
    // throwaway <a download> click, the standard no-dependency technique;
    // nothing here is ever proxied through anywhere, it's a straight
    // save of the response body already sitting in memory.
    const blob = new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `mlpr-backup-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
  });

  importBtn.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file) return;

    statusEl.textContent = '';
    errorEl.textContent = '';

    // Same "this is hard to walk back, confirm first" precedent the
    // server-port change already set -- restoring an old backup can just
    // as easily lock someone out (a different/no Settings password, a
    // stale port) as a mistyped port can.
    if (!window.confirm(t('confirmConfigImport'))) return;

    let dump;
    try {
      dump = JSON.parse(await file.text());
    } catch {
      errorEl.textContent = t('configImportError');
      return;
    }

    const response = await authedFetch(
      '/api/settings/import',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(dump),
      },
      onUnauthorized,
    );
    if (!response) return;
    if (!response.ok) {
      errorEl.textContent = t('configImportError');
      return;
    }
    statusEl.textContent = t('configImportSuccess');
  });
}

// Gated the same way as the Server tab (and for the same reason -- see
// server.js's comment on why broker credentials get this treatment while
// the rest of Notifications doesn't): a password, if one is set, protects
// this tab's whole content, not just individual fields.
async function renderSmartHomeTab(root) {
  let status;
  try {
    status = await fetch('/api/settings-auth/status').then((res) => res.json());
  } catch {
    status = { passwordSet: false };
  }

  if (status.passwordSet && !getStoredToken()) {
    renderGate(root, () => renderSmartHomeTab(root));
    return;
  }

  root.innerHTML = `
    <fieldset class="mlpr-settings-group">
      <legend>${t('tabSmartHome')}</legend>
      <p class="mlpr-home-status">${t('smartHomeIntro')}</p>
      <label><input type="checkbox" id="mlpr-smarthome-enable"> ${t('smartHomeEnable')}</label>
      <label>${t('smartHomeBrokerUrl')} <input type="text" id="mlpr-smarthome-url" placeholder="mqtt://192.168.1.50:1883"></label>
      <p class="mlpr-home-status">${t('smartHomeBrokerUrlHint')}</p>
      <label>${t('smartHomeUsername')} <input type="text" id="mlpr-smarthome-username"></label>
      <label>${t('smartHomePassword')} <input type="password" id="mlpr-smarthome-password"></label>
      <label>${t('smartHomeTopicPrefix')} <input type="text" id="mlpr-smarthome-prefix" placeholder="mlpr"></label>
      <p class="mlpr-home-status">${t('smartHomeTopicPrefixHint')}</p>
      <div class="mlpr-home-actions">
        <button type="button" id="mlpr-smarthome-save">${t('save')}</button>
        <button type="button" id="mlpr-smarthome-test">${t('smartHomeTestConnection')}</button>
      </div>
      <p id="mlpr-smarthome-status" class="mlpr-home-status"></p>
      <p id="mlpr-smarthome-error" class="mlpr-gate-error"></p>
    </fieldset>
  `;

  wireSmartHomeTab(root, () => renderSmartHomeTab(root));
}

function wireSmartHomeTab(root, onUnauthorized) {
  const enableEl = root.querySelector('#mlpr-smarthome-enable');
  const urlEl = root.querySelector('#mlpr-smarthome-url');
  const usernameEl = root.querySelector('#mlpr-smarthome-username');
  const passwordEl = root.querySelector('#mlpr-smarthome-password');
  const prefixEl = root.querySelector('#mlpr-smarthome-prefix');
  const saveBtn = root.querySelector('#mlpr-smarthome-save');
  const testBtn = root.querySelector('#mlpr-smarthome-test');
  const statusEl = root.querySelector('#mlpr-smarthome-status');
  const errorEl = root.querySelector('#mlpr-smarthome-error');

  function currentFormValues() {
    return {
      enabled: enableEl.checked,
      brokerUrl: urlEl.value.trim(),
      username: usernameEl.value,
      password: passwordEl.value,
      topicPrefix: prefixEl.value.trim(),
    };
  }

  async function load() {
    const response = await authedFetch('/api/notifications/smart-home', undefined, onUnauthorized);
    if (!response) return;
    const data = await response.json();
    enableEl.checked = data.enabled;
    urlEl.value = data.brokerUrl;
    usernameEl.value = data.username;
    passwordEl.value = data.password;
    prefixEl.value = data.topicPrefix;
  }

  saveBtn.addEventListener('click', async () => {
    errorEl.textContent = '';
    statusEl.textContent = '';
    const response = await authedFetch(
      '/api/notifications/smart-home',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(currentFormValues()),
      },
      onUnauthorized,
    );
    if (!response) return;
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      errorEl.textContent = data.error ?? t('somethingWentWrong');
      return;
    }
    statusEl.textContent = t('smartHomeSaved');
  });

  testBtn.addEventListener('click', async () => {
    errorEl.textContent = '';
    statusEl.textContent = t('smartHomeTesting');
    const { brokerUrl, username, password } = currentFormValues();
    const response = await authedFetch(
      '/api/notifications/smart-home/test',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ brokerUrl, username, password }),
      },
      onUnauthorized,
    );
    if (!response) return;
    const data = await response.json().catch(() => ({}));
    statusEl.textContent = data.ok ? t('smartHomeTestSuccess') : `${t('smartHomeTestFailed')} ${data.error ?? ''}`;
  });

  load();
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

  // A reload, not a live re-render -- translations are baked into static
  // markup (button labels, aria-labels, document.documentElement.lang...)
  // set once at render time all over the app, not something there's one
  // central place to redo live. Simplest way to guarantee every corner of
  // the UI actually picks up the new language consistently, rather than
  // risking some already-rendered panel being left in the old one.
  container.querySelector('#mlpr-language').addEventListener('change', (event) => {
    updateSettings({ language: event.target.value });
    location.reload();
  });

  container.querySelector('#mlpr-alt-min').addEventListener('change', (event) => {
    updateSettings({ altitudeFilterMin: event.target.value === '' ? null : Number(event.target.value) });
  });
  container.querySelector('#mlpr-alt-max').addEventListener('change', (event) => {
    updateSettings({ altitudeFilterMax: event.target.value === '' ? null : Number(event.target.value) });
  });

  const iconSizeInput = container.querySelector('#mlpr-icon-size');
  const iconSizeValue = container.querySelector('#mlpr-icon-size-value');
  iconSizeInput.addEventListener('input', (event) => {
    // 'input' (not just 'change') so the live px label and the map marker
    // size both track the slider while dragging, not only on release.
    iconSizeValue.textContent = `${event.target.value}px`;
    updateSettings({ aircraftIconSize: Number(event.target.value) });
  });

  for (const input of container.querySelectorAll('input[name="mlpr-plane-color-mode"]')) {
    input.addEventListener('change', (event) => updateSettings({ planeColorMode: event.target.value }));
  }

  const labelFieldInputs = {
    flight: container.querySelector('#mlpr-label-flight'),
    type: container.querySelector('#mlpr-label-type'),
    altitude: container.querySelector('#mlpr-label-altitude'),
    speed: container.querySelector('#mlpr-label-speed'),
  };
  for (const [field, input] of Object.entries(labelFieldInputs)) {
    input.addEventListener('change', (event) => {
      updateSettings({ aircraftLabelFields: { ...getSettings().aircraftLabelFields, [field]: event.target.checked } });
    });
  }

  for (const input of container.querySelectorAll('input[name="mlpr-basemap-mode"]')) {
    input.addEventListener('change', (event) => updateSettings({ basemapMode: event.target.value }));
  }

  for (const input of container.querySelectorAll('input[name="mlpr-map-theme"]')) {
    input.addEventListener('change', (event) => updateSettings({ mapTheme: event.target.value }));
  }

  for (const input of container.querySelectorAll('input[name="mlpr-trail-mode"]')) {
    input.addEventListener('change', (event) => updateSettings({ trailMode: event.target.value }));
  }

  container.querySelector('#mlpr-shorter-trails').addEventListener('change', (event) => {
    updateSettings({ shorterTrails: event.target.checked });
  });

  container.querySelector('#mlpr-show-home-marker').addEventListener('change', (event) => {
    updateSettings({ showHomeMarker: event.target.checked });
  });

  container.querySelector('#mlpr-show-coverage').addEventListener('change', (event) => {
    updateSettings({ showCoverage: event.target.checked });
  });

  container.querySelector('#mlpr-coverage-band').addEventListener('change', (event) => {
    updateSettings({ coverageBand: event.target.value === 'all' ? 'all' : Number(event.target.value) });
  });

  container.querySelector('#mlpr-fetch-photos').addEventListener('change', (event) => {
    updateSettings({ fetchAircraftPhotos: event.target.checked });
  });
}

function wireServerPort(container, onUnauthorized) {
  const portInput = container.querySelector('#mlpr-server-port');
  const statusEl = container.querySelector('#mlpr-server-port-status');
  const errorEl = container.querySelector('#mlpr-server-port-error');
  const saveBtn = container.querySelector('#mlpr-server-port-save');

  async function loadPort() {
    const response = await authedFetch('/api/server/port', undefined, onUnauthorized);
    if (!response) return;
    const data = await response.json();
    portInput.value = data.port;
    // An MLPR_PORT env var beats the stored setting, so say so explicitly
    // rather than letting the field look like it's in charge when it isn't.
    statusEl.textContent = data.source === 'env' ? t('portEnvOverride') : '';
  }

  saveBtn.addEventListener('click', async () => {
    errorEl.textContent = '';
    statusEl.textContent = '';

    const newPort = Number(portInput.value);
    // location.hostname is exactly the host the user is *already* reaching
    // this page on -- only the port segment is about to change, so this is
    // the precise new address, not a vague "somewhere else" warning. Easy
    // to lock yourself out of a headless Pi by mistyping a port and then
    // not remembering what you changed it to, so this is a confirm(), not
    // just an inline note.
    const newUrl = `${location.protocol}//${location.hostname}:${newPort}`;
    const confirmed = window.confirm(`${t('portChangeConfirmPrefix')}\n\n${newUrl}\n\n${t('portChangeConfirmSuffix')}`);
    if (!confirmed) return;

    const response = await authedFetch(
      '/api/server/port',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ port: newPort }),
      },
      onUnauthorized,
    );
    if (!response) return;

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      errorEl.textContent = data.error ?? t('somethingWentWrong');
      return;
    }
    statusEl.textContent = t('portRestartRequired');
  });

  loadPort();
}

function wireHomeLocation(container, onUnauthorized) {
  const homeLatInput = container.querySelector('#mlpr-home-lat');
  const homeLonInput = container.querySelector('#mlpr-home-lon');
  const homeStatusEl = container.querySelector('#mlpr-home-status');
  const homeResetBtn = container.querySelector('#mlpr-home-reset');
  const homeSaveBtn = container.querySelector('#mlpr-home-save');

  async function loadHome() {
    const response = await authedFetch('/api/settings', undefined, onUnauthorized);
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

    const response = await authedFetch(
      '/api/settings',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ homeLat, homeLon }),
      },
      onUnauthorized,
    );
    if (!response) return;
    await loadHome();
  });

  homeResetBtn.addEventListener('click', async () => {
    const response = await authedFetch(
      '/api/settings',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ homeLat: null, homeLon: null }),
      },
      onUnauthorized,
    );
    if (!response) return;
    await loadHome();
  });

  loadHome();
}

// The main Notifications view's rule toggles. Split from the ntfy section
// below (which now lives in the "Configure notifications" subview) purely
// because the two no longer render at the same time -- querying for the
// ntfy elements here would find nothing until that subview is opened.
function wireNotificationToggles(container) {
  const notifSquawkEl = container.querySelector('#mlpr-notif-squawk');
  const notif7500El = container.querySelector('#mlpr-notif-squawk-7500');
  const notif7600El = container.querySelector('#mlpr-notif-squawk-7600');
  const notif7700El = container.querySelector('#mlpr-notif-squawk-7700');
  const notifFirstSeenEl = container.querySelector('#mlpr-notif-firstseen');
  const notifWatchedEl = container.querySelector('#mlpr-notif-watched');
  const notifRangeRecordEl = container.querySelector('#mlpr-notif-rangerecord');

  async function loadNotificationSettings() {
    const response = await fetch('/api/notifications/settings');
    if (!response) return;
    const data = await response.json();
    notifSquawkEl.checked = data.squawkEnabled;
    notif7500El.checked = data.squawkCodes['7500'];
    notif7600El.checked = data.squawkCodes['7600'];
    notif7700El.checked = data.squawkCodes['7700'];
    notifFirstSeenEl.checked = data.firstSeenEnabled;
    notifWatchedEl.checked = data.watchedEnabled;
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
  notifWatchedEl.addEventListener('change', (event) =>
    putNotificationSettings({ watchedEnabled: event.target.checked }),
  );
  notifRangeRecordEl.addEventListener('change', (event) =>
    putNotificationSettings({ rangeRecordEnabled: event.target.checked }),
  );

  loadNotificationSettings();
}

function wireNtfySection(root) {
  const ntfyTopicEl = root.querySelector('#mlpr-ntfy-topic');
  const ntfyRegenerateBtn = root.querySelector('#mlpr-ntfy-regenerate');

  async function loadNtfyTopic() {
    const response = await fetch('/api/notifications/ntfy-topic');
    if (!response) return;
    const data = await response.json();
    ntfyTopicEl.textContent = data.topic;
  }

  ntfyRegenerateBtn.addEventListener('click', async () => {
    const response = await fetch('/api/notifications/ntfy-topic/regenerate', { method: 'POST' });
    if (!response) return;
    const data = await response.json();
    ntfyTopicEl.textContent = data.topic;
  });

  loadNtfyTopic();
}

// Human-readable summary of an entry's optional trigger area. Kept next to
// watchEntryLabel rather than in the editor module -- this is the read-only
// "what did I configure" wording, which the editor itself never needs.
function areaSummary(area) {
  if (!area) return t('noAreaCondition');
  const { units } = getSettings();
  if (area.kind === 'circle') {
    return `${t('areaCircleLabel')} · ${t('areaWithin')} ${formatDistance(area.radiusKm, units)}`;
  }
  if (area.kind === 'rectangle') {
    return `${t('areaRectangleLabel')} · ${formatDistance(area.widthKm, units)} × ${formatDistance(area.heightKm, units)}`;
  }
  // A shape this build doesn't know about (an entry written by a newer
  // version) still deserves a label rather than a blank -- rules.js
  // separately refuses to match it, see satisfiesAreaCondition.
  return t('areaEditorTitle');
}

function watchEntryLabel(entry) {
  const typeLabel = { type: t('watchType'), registration: t('watchRegistration'), flight: t('watchFlight') }[
    entry.matchType
  ];
  let text = `${typeLabel}: ${entry.matchValue}`;
  if (entry.altitudeOperator) {
    text += ` (${entry.altitudeOperator === 'below' ? t('below') : t('above')} ${entry.altitudeValue} ft)`;
  }
  if (entry.area) {
    text += ` · ${areaSummary(entry.area)}`;
  }
  return text;
}

function wireWatchlist(container) {
  const itemsEl = container.querySelector('#mlpr-watchlist-items');
  const typeSelect = container.querySelector('#mlpr-watch-type');
  const valueInput = container.querySelector('#mlpr-watch-value');
  const altOpSelect = container.querySelector('#mlpr-watch-alt-op');
  const altValueInput = container.querySelector('#mlpr-watch-alt-value');
  const areaBtn = container.querySelector('#mlpr-watch-area');
  const areaSummaryEl = container.querySelector('#mlpr-watch-area-summary');
  const addBtn = container.querySelector('#mlpr-watch-add');
  const errorEl = container.querySelector('#mlpr-watch-error');

  // The area being built up for the entry that's about to be added --
  // held here rather than read back off the DOM, since it's a structured
  // object (shape + coordinates), not something a form control can hold.
  // Reset alongside the other inputs after a successful add.
  let pendingArea = null;

  function refreshAreaUi() {
    areaBtn.textContent = pendingArea ? t('editArea') : t('setArea');
    areaSummaryEl.textContent = pendingArea ? areaSummary(pendingArea) : '';
  }

  areaBtn.addEventListener('click', async () => {
    const result = await openAreaEditor(pendingArea);
    // undefined = cancelled (leave whatever was there); null = explicitly
    // cleared in the editor. Distinguishing the two is why the editor
    // resolves rather than just returning an area.
    if (result === undefined) return;
    pendingArea = result;
    refreshAreaUi();
  });

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
    const response = await fetch('/api/notifications/watchlist');
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
        const deleteResponse = await fetch(`/api/notifications/watchlist/${entry.id}`, {
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
      area: pendingArea,
    };

    const response = await fetch('/api/notifications/watchlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      errorEl.textContent = data.error ?? t('somethingWentWrong');
      return;
    }

    valueInput.value = '';
    altOpSelect.value = '';
    altValueInput.value = '';
    altValueInput.style.display = 'none';
    pendingArea = null;
    refreshAreaUi();
    await loadWatchlist();
  });

  refreshAreaUi();
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
