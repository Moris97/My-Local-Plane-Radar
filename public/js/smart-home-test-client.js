// Client for /dev/smart-home-test -- fires a real event through the actual
// configured MQTT connection (server.js's POST .../send-test-event, which
// calls the real publishSmartHomeEvent(), not a temporary test socket) so a
// user can verify their Home Assistant automations without waiting for a
// genuine first-seen/watch-list match. Reuses settings-auth.js directly
// (same sessionStorage token Settings' own Server/Smart-Home tabs use) --
// gated the same way as the smart-home API itself.
import { authorizedFetch, storeToken, clearStoredToken, getStoredToken } from './settings-auth.js';

const PRESETS = {
  landing: {
    reason: 'watchlist',
    matchedType: 'type',
    matchedValue: 'A388',
    hex: 'a1b2c3',
    flight: 'DLH123',
    registration: 'D-AIMA',
    typeCode: 'A388',
    altitude: 800,
    speed: 140,
    onGround: false,
    lat: '',
    lon: '',
  },
  firstseen: {
    reason: 'first_seen',
    matchedType: 'type',
    matchedValue: '',
    hex: Math.random().toString(16).slice(2, 8),
    flight: 'TEST123',
    registration: 'SP-TST',
    typeCode: 'C172',
    altitude: 2500,
    speed: 95,
    onGround: false,
    lat: '',
    lon: '',
  },
};

function renderGate(container, onUnlocked) {
  container.innerHTML = `
    <div class="mlpr-gate">
      <p>This section is password protected.</p>
      <label>Password <input type="password" id="gate-password"></label>
      <button type="button" id="gate-submit">Unlock</button>
      <p id="gate-error" class="mlpr-gate-error"></p>
    </div>
  `;
  const passwordInput = container.querySelector('#gate-password');
  const errorEl = container.querySelector('#gate-error');

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
      errorEl.textContent = 'Incorrect password';
    }
  }

  container.querySelector('#gate-submit').addEventListener('click', attempt);
  passwordInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') attempt();
  });
}

function currentFormValues() {
  const reason = document.getElementById('f-reason').value;
  const aircraft = {
    hex: document.getElementById('f-hex').value.trim(),
    flight: document.getElementById('f-flight').value.trim() || undefined,
    registration: document.getElementById('f-registration').value.trim() || undefined,
    typeCode: document.getElementById('f-typecode').value.trim() || undefined,
    altBaro: document.getElementById('f-altitude').value ? Number(document.getElementById('f-altitude').value) : undefined,
    gs: document.getElementById('f-speed').value ? Number(document.getElementById('f-speed').value) : undefined,
    onGround: document.getElementById('f-onground').checked,
    lat: document.getElementById('f-lat').value ? Number(document.getElementById('f-lat').value) : undefined,
    lon: document.getElementById('f-lon').value ? Number(document.getElementById('f-lon').value) : undefined,
  };
  const matchedEntry = reason === 'watchlist'
    ? { matchType: document.getElementById('f-matched-type').value, matchValue: document.getElementById('f-matched-value').value.trim() }
    : undefined;
  return { reason, aircraft, matchedEntry };
}

function updatePreview(topicPrefix) {
  const { reason, aircraft, matchedEntry } = currentFormValues();
  document.getElementById('topic-preview').textContent = `${topicPrefix}/events/${reason}`;
  const payload = { reason, timestamp: Date.now(), ...aircraft };
  if (matchedEntry) Object.assign(payload, { matchedType: matchedEntry.matchType, matchedValue: matchedEntry.matchValue });
  document.getElementById('payload-preview').textContent = JSON.stringify(payload, null, 2);
}

function applyPreset(name) {
  const preset = PRESETS[name];
  document.getElementById('f-reason').value = preset.reason;
  document.getElementById('f-matched-type').value = preset.matchedType;
  document.getElementById('f-matched-value').value = preset.matchedValue;
  document.getElementById('f-hex').value = preset.hex;
  document.getElementById('f-flight').value = preset.flight;
  document.getElementById('f-registration').value = preset.registration;
  document.getElementById('f-typecode').value = preset.typeCode;
  document.getElementById('f-altitude').value = preset.altitude;
  document.getElementById('f-speed').value = preset.speed;
  document.getElementById('f-onground').checked = preset.onGround;
  document.getElementById('f-lat').value = preset.lat;
  document.getElementById('f-lon').value = preset.lon;
  document.getElementById('watchlist-fields').style.display = preset.reason === 'watchlist' ? '' : 'none';
}

async function main() {
  const gateContainer = document.getElementById('gate-container');
  const mainContainer = document.getElementById('main-container');

  let authStatus;
  try {
    authStatus = await fetch('/api/settings-auth/status').then((r) => r.json());
  } catch {
    authStatus = { passwordSet: false };
  }

  if (authStatus.passwordSet && !getStoredToken()) {
    renderGate(gateContainer, main);
    return;
  }

  gateContainer.innerHTML = '';
  mainContainer.style.display = '';

  const onUnauthorized = () => {
    clearStoredToken();
    main();
  };

  async function refreshStatus() {
    const response = await authorizedFetch('/api/notifications/smart-home');
    if (response.status === 401) {
      onUnauthorized();
      return null;
    }
    const data = await response.json();
    const banner = document.getElementById('status-banner');
    if (!data.enabled) {
      banner.innerHTML = `<span class="dot off"></span>Smart home is disabled -- enable it in Settings first.`;
    } else {
      banner.innerHTML = data.connected
        ? `<span class="dot on"></span>Enabled and connected to <code>${data.brokerUrl}</code>.`
        : `<span class="dot off"></span>Enabled but not currently connected to <code>${data.brokerUrl}</code>.`;
    }
    updatePreview(data.topicPrefix);
    return data;
  }

  const status = await refreshStatus();
  if (!status) return;

  document.getElementById('f-reason').addEventListener('change', (event) => {
    document.getElementById('watchlist-fields').style.display = event.target.value === 'watchlist' ? '' : 'none';
    updatePreview(status.topicPrefix);
  });
  for (const id of ['f-hex', 'f-flight', 'f-registration', 'f-typecode', 'f-altitude', 'f-speed', 'f-onground', 'f-lat', 'f-lon', 'f-matched-type', 'f-matched-value']) {
    document.getElementById(id).addEventListener('input', () => updatePreview(status.topicPrefix));
  }

  for (const btn of document.querySelectorAll('button[data-preset]')) {
    btn.addEventListener('click', () => {
      applyPreset(btn.dataset.preset);
      updatePreview(status.topicPrefix);
    });
  }

  document.getElementById('send-btn').addEventListener('click', async () => {
    const resultEl = document.getElementById('result');
    resultEl.className = '';
    resultEl.textContent = 'Sending…';

    const { reason, aircraft, matchedEntry } = currentFormValues();
    if (!aircraft.hex) {
      resultEl.className = 'error';
      resultEl.textContent = 'Hex is required.';
      return;
    }

    const response = await authorizedFetch('/api/notifications/smart-home/send-test-event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason, aircraft, matchedEntry }),
    });
    if (response.status === 401) {
      onUnauthorized();
      return;
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      resultEl.className = 'error';
      resultEl.textContent = data.error ?? 'Something went wrong.';
      return;
    }
    if (data.sent) {
      resultEl.className = 'ok';
      resultEl.textContent = 'Sent -- check your Home Assistant automation.';
    } else {
      resultEl.className = 'error';
      resultEl.textContent = data.enabled
        ? 'Not sent -- smart home is enabled but not currently connected to the broker.'
        : 'Not sent -- smart home is disabled in Settings.';
    }
    refreshStatus();
  });
}

main();
