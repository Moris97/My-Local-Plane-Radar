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

function openPanel(name) {
  const entry = PANELS[name];
  if (!entry) return;

  disposeCurrent?.();

  currentPanel = name;
  titleEl.textContent = entry.title();
  contentEl.innerHTML = '';
  disposeCurrent = entry.render(contentEl) ?? null;

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
}

function closePanel({ fromPopstate = false } = {}) {
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
