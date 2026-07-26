import { t } from './i18n.js';
import { renderListPanel } from './list.js';
import { renderStatsPanel } from './stats.js';
import { renderSettingsPanel } from './settings.js';

const PANELS = {
  list: { title: () => t('list'), render: renderListPanel },
  stats: { title: () => t('stats'), render: renderStatsPanel },
  settings: { title: () => t('settings'), render: renderSettingsPanel },
};

const barButtons = document.querySelectorAll('.mlpr-bar-btn');
const panelEl = document.getElementById('panel');
const overlayEl = document.getElementById('panel-overlay');
const titleEl = document.getElementById('panel-title');
const contentEl = document.getElementById('panel-content');
const closeBtn = document.getElementById('panel-close');

let currentPanel = null;
let historyPushed = false;
let disposeCurrent = null;
let renderToken = 0;

async function openPanel(name) {
  const entry = PANELS[name];
  if (!entry) return;

  renderToken += 1;
  const myToken = renderToken;

  disposeCurrent?.();
  disposeCurrent = null;

  currentPanel = name;
  titleEl.textContent = entry.title();
  contentEl.innerHTML = '';

  panelEl.classList.remove('hidden');
  panelEl.setAttribute('aria-hidden', 'false');
  overlayEl.classList.remove('hidden');

  for (const btn of barButtons) {
    btn.classList.toggle('active', btn.dataset.panel === name);
  }

  if (!historyPushed) {
    history.pushState({ mlprPanel: true }, '');
    historyPushed = true;
  }

  const result = await entry.render(contentEl);
  if (myToken === renderToken) {
    disposeCurrent = result ?? null;
  } else if (typeof result === 'function') {
    result();
  }
}

function closePanel({ fromPopstate = false } = {}) {
  renderToken += 1;
  disposeCurrent?.();
  disposeCurrent = null;
  currentPanel = null;

  panelEl.classList.add('hidden');
  panelEl.setAttribute('aria-hidden', 'true');
  overlayEl.classList.add('hidden');

  for (const btn of barButtons) btn.classList.remove('active');

  if (historyPushed) {
    historyPushed = false;
    if (!fromPopstate) history.back();
  }
}

for (const btn of barButtons) {
  btn.addEventListener('click', () => {
    if (currentPanel === btn.dataset.panel) {
      closePanel();
    } else {
      openPanel(btn.dataset.panel);
    }
  });
}

closeBtn.addEventListener('click', () => closePanel());
overlayEl.addEventListener('click', () => closePanel());
window.addEventListener('popstate', () => closePanel({ fromPopstate: true }));
