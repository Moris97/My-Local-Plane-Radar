import { t, getLanguage } from './i18n.js';
import { renderListPanel } from './list.js';
import { renderStatsPanel } from './stats.js';
import { renderSettingsPanel } from './settings.js';
import { renderAircraftDetailsPanel, aircraftDetailsPanelTitle } from './aircraft-panel.js';

// Bottom-sheet on phones / side panel on desktop (see the @media block in
// style.css).
const PANELS = {
  list: { title: () => t('list'), render: renderListPanel },
  settings: { title: () => t('settings'), render: renderSettingsPanel },
  // Not tied to a bottom-bar button -- opened contextually from the
  // "show more details" button in an aircraft's popup (see app.js).
  aircraft: { title: aircraftDetailsPanelTitle, render: renderAircraftDetailsPanel },
};

// Full-screen instead -- currently just Stats, which is getting more
// screen-hungry options later; kept as its own registry (not shoehorned
// into PANELS) so future full-screen views don't need special-casing here.
const FULLSCREEN_MODALS = {
  stats: { title: () => t('stats'), render: renderStatsPanel },
};

const barButtons = document.querySelectorAll('.mlpr-bar-btn');
const panelEl = document.getElementById('panel');
const overlayEl = document.getElementById('panel-overlay');
const titleEl = document.getElementById('panel-title');
const contentEl = document.getElementById('panel-content');
const closeBtn = document.getElementById('panel-close');

const modalEl = document.getElementById('fullscreen-modal');
const modalTitleEl = document.getElementById('fullscreen-modal-title');
const modalContentEl = document.getElementById('fullscreen-modal-content');
const modalCloseBtn = document.getElementById('fullscreen-modal-close');

// This module (imported by app.js, evaluated before app.js's own top-level
// code including the WebGL-dependent `new maplibregl.Map(...)`) is the
// first reliable place to touch the DOM regardless of whether the map
// itself ever comes up -- <html lang> and the close buttons' aria-label
// both need to be set unconditionally, not tucked behind map init.
document.documentElement.lang = getLanguage();
closeBtn.setAttribute('aria-label', t('close'));
modalCloseBtn.setAttribute('aria-label', t('close'));

for (const btn of barButtons) {
  const entry = PANELS[btn.dataset.panel] ?? FULLSCREEN_MODALS[btn.dataset.panel];
  const label = btn.querySelector('.mlpr-bar-btn-label');
  if (entry && label) {
    label.textContent = entry.title();
    // Was previously a hardcoded English aria-label in index.html, which
    // never matched the Polish UI -- now driven by the same translated
    // title as the visible label, so it can't drift out of sync.
    btn.setAttribute('aria-label', entry.title());
  }
}

let currentPanel = null;
let currentModal = null;
// Shared across both mechanisms: exactly one history entry exists whenever
// *either* is open, pushed on the first open and consumed on the last
// close. Switching directly between the two (e.g. List -> Stats) must not
// touch history at all -- it's still "one thing open", just a different
// one; pushing/popping on every switch would desync the back-gesture from
// what's actually on screen.
let historyPushed = false;
let disposeCurrent = null;
let renderToken = 0;
// Whatever had focus right before a panel/modal opened -- typically the
// bottom-bar button, or the "show more details" button for the contextual
// aircraft panel -- so closing can hand focus back rather than stranding it
// on a now-hidden (display:none, so unfocusable) element.
let lastFocusedElement = null;

function setActiveBarButton(name) {
  for (const btn of barButtons) {
    btn.classList.toggle('active', btn.dataset.panel === name);
  }
}

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// Keeps Tab/Shift+Tab cycling within the open panel/modal instead of
// leaking focus out to the map or bottom bar underneath -- standard modal
// dialog behavior. Attached once to each container below; a `keydown` on a
// `display:none` container (i.e. while closed) never fires in the first
// place, so no open/closed guard is needed here.
function trapFocus(containerEl, event) {
  if (event.key !== 'Tab') return;
  const focusable = containerEl.querySelectorAll(FOCUSABLE_SELECTOR);
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function restoreFocus() {
  if (lastFocusedElement && document.body.contains(lastFocusedElement)) {
    lastFocusedElement.focus();
  }
  lastFocusedElement = null;
}

function hidePanelUI() {
  panelEl.classList.add('hidden');
  panelEl.setAttribute('aria-hidden', 'true');
  overlayEl.classList.add('hidden');
  currentPanel = null;
}

function hideModalUI() {
  modalEl.classList.add('hidden');
  modalEl.setAttribute('aria-hidden', 'true');
  currentModal = null;
}

export async function openPanel(name) {
  const entry = PANELS[name];
  if (!entry) return;

  // Only capture on a closed -> open transition, not a direct switch
  // between panel and modal (e.g. List -> Stats) -- otherwise this would
  // capture focus already inside the panel being switched *away* from,
  // and restoring to that later (once everything is closed) would try to
  // focus an element inside now-hidden, about-to-be-replaced content
  // instead of wherever the user actually started.
  if (!currentPanel && !currentModal) {
    lastFocusedElement = document.activeElement;
  }

  hideModalUI();

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
  setActiveBarButton(name);
  // Moves focus into the dialog immediately (not gated on the render below,
  // which can be async) -- standard modal-open behavior, and means a
  // keyboard/screen-reader user always lands somewhere inside it rather
  // than on whatever was focused on the page underneath.
  closeBtn.focus();

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
  if (!currentPanel) return;

  renderToken += 1;
  disposeCurrent?.();
  disposeCurrent = null;
  hidePanelUI();
  setActiveBarButton(null);
  restoreFocus();

  if (historyPushed) {
    historyPushed = false;
    if (!fromPopstate) history.back();
  }
}

async function openFullscreenModal(name) {
  const entry = FULLSCREEN_MODALS[name];
  if (!entry) return;

  // See the matching comment in openPanel -- same "only on a genuinely
  // closed -> open transition" reasoning.
  if (!currentPanel && !currentModal) {
    lastFocusedElement = document.activeElement;
  }

  hidePanelUI();

  renderToken += 1;
  const myToken = renderToken;
  disposeCurrent?.();
  disposeCurrent = null;

  currentModal = name;
  modalTitleEl.textContent = entry.title();
  modalContentEl.innerHTML = '';

  modalEl.classList.remove('hidden');
  modalEl.setAttribute('aria-hidden', 'false');
  setActiveBarButton(name);
  modalCloseBtn.focus();

  if (!historyPushed) {
    history.pushState({ mlprPanel: true }, '');
    historyPushed = true;
  }

  const result = await entry.render(modalContentEl);
  if (myToken === renderToken) {
    disposeCurrent = result ?? null;
  } else if (typeof result === 'function') {
    result();
  }
}

function closeFullscreenModal({ fromPopstate = false } = {}) {
  if (!currentModal) return;

  renderToken += 1;
  disposeCurrent?.();
  disposeCurrent = null;
  hideModalUI();
  setActiveBarButton(null);
  restoreFocus();

  if (historyPushed) {
    historyPushed = false;
    if (!fromPopstate) history.back();
  }
}

for (const btn of barButtons) {
  btn.addEventListener('click', () => {
    const name = btn.dataset.panel;
    if (currentPanel === name) {
      closePanel();
    } else if (currentModal === name) {
      closeFullscreenModal();
    } else if (FULLSCREEN_MODALS[name]) {
      openFullscreenModal(name);
    } else {
      openPanel(name);
    }
  });
}

closeBtn.addEventListener('click', () => closePanel());
overlayEl.addEventListener('click', () => closePanel());
modalCloseBtn.addEventListener('click', () => closeFullscreenModal());
panelEl.addEventListener('keydown', (event) => trapFocus(panelEl, event));
modalEl.addEventListener('keydown', (event) => trapFocus(modalEl, event));
window.addEventListener('popstate', () => {
  closePanel({ fromPopstate: true });
  closeFullscreenModal({ fromPopstate: true });
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  // Not fromPopstate -- this is a fresh close, same as clicking X or the
  // overlay, so it still needs to consume the pushed history entry itself
  // (closePanel/closeFullscreenModal call history.back() for that).
  if (currentPanel) closePanel();
  else if (currentModal) closeFullscreenModal();
});
