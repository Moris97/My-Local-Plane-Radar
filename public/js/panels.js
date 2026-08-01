import { t, getLanguage } from './i18n.js';
import { renderListPanel } from './list.js';
import { renderStatsPanel } from './stats.js';
import { renderSettingsPanel } from './settings.js';
import { renderAircraftDetailsPanel, aircraftDetailsPanelTitle } from './aircraft-panel.js';
import { getSettings, updateSettings } from './settings-state.js';

// Bottom-sheet on phones / side panel on desktop (see the @media block in
// style.css). `fill: true` makes the panel reach the true screen bottom
// instead of stopping above the bottom bar -- see the mlpr-panel-fill CSS
// rule, toggled below in openPanel/openFullscreenModal. Originally List-only
// (it needed the extra height for a long table); every panel/modal now gets
// it, since stopping short also meant the live map (aircraft, trails, place
// labels) visibly showed through the gap above the bar under Stats/Settings/
// aircraft details too -- reported live as a visual bug (2026-08-01), not
// something anyone had wanted on purpose.
const PANELS = {
  list: { title: () => t('list'), render: renderListPanel, fill: true },
  settings: { title: () => t('settings'), render: renderSettingsPanel, fill: true },
  // Not tied to a bottom-bar button -- opened contextually from the
  // "show more details" button in an aircraft's popup (see app.js).
  aircraft: { title: aircraftDetailsPanelTitle, render: renderAircraftDetailsPanel, fill: true },
};

// Full-screen instead -- currently Stats and the List's own "open
// fullscreen" button (see list.js), kept as its own registry (not
// shoehorned into PANELS) so future full-screen views don't need
// special-casing here. listFull renders the exact same list.js view as
// PANELS.list, just with more screen real estate -- not a separate
// column/sort configuration.
const FULLSCREEN_MODALS = {
  stats: { title: () => t('stats'), render: renderStatsPanel, fill: true },
  listFull: { title: () => t('list'), render: (el) => renderListPanel(el, { fullscreen: true }), fill: true },
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
const resizeHandleEl = document.getElementById('panel-resize-handle');

const SIDE_PANEL_MIN_WIDTH = 320;
const SIDE_PANEL_MAX_WIDTH = 900;
const SIDE_PANEL_LAYOUT_QUERY = '(min-width: 900px)';

// Exported so list.js can decide, alongside the same breakpoint, whether its
// Configure view has room to float as a separate window next to #panel (see
// list.js's "floating" mode) or must fall back to swapping the table out
// in place instead (mobile bottom sheet, no room for a second window at all).
export function isSidePanelLayout() {
  return window.matchMedia(SIDE_PANEL_LAYOUT_QUERY).matches;
}

// Applies the persisted width (drag-to-resize, see below) as an inline
// style -- only in the >=900px side-panel layout, where #panel has an
// actual "width" to speak of; below that it's a full-width bottom sheet, and
// an inline width here would override that (inline styles win over the
// external stylesheet's media-query rules regardless of specificity) and
// wrongly pin it to a fixed pixel width. Called on every panel open and on
// window resize, so crossing the breakpoint with a panel already open
// (e.g. rotating a tablet, or resizing a desktop browser window) still
// lands on the right layout. Deliberately the *only* thing that ever sets
// #panel's width -- List's Configure view used to also grow it temporarily,
// but that was reverted (2026-07-28, explicit request): opening/closing
// Configure must never change #panel's width, position, or any of its
// buttons, full stop. See list.js's separate #list-config-window instead.
function applySidePanelWidth() {
  if (!isSidePanelLayout()) {
    panelEl.style.width = '';
    return;
  }
  const maxWidth = Math.min(SIDE_PANEL_MAX_WIDTH, window.innerWidth - 40);
  panelEl.style.width = `${Math.min(maxWidth, getSettings().sidePanelWidth)}px`;
}

window.addEventListener('resize', applySidePanelWidth);

resizeHandleEl.addEventListener('pointerdown', (event) => {
  if (!isSidePanelLayout()) return;
  event.preventDefault();
  resizeHandleEl.setPointerCapture(event.pointerId);
  resizeHandleEl.classList.add('mlpr-resize-active');
  // #panel is right-docked (right:0, left:auto in the side-panel layout) --
  // its right edge stays fixed while dragging, so width is just how far the
  // pointer is from that fixed edge, not from the (moving) left edge.
  const fixedRight = panelEl.getBoundingClientRect().right;
  const maxWidth = Math.min(SIDE_PANEL_MAX_WIDTH, window.innerWidth - 40);
  // Dragging across the panel's own text/content would otherwise select it
  // like any other drag gesture -- standard resize-handle UX is to suppress
  // that for the duration of the drag.
  const previousUserSelect = document.body.style.userSelect;
  document.body.style.userSelect = 'none';

  function widthFor(pointerEvent) {
    return Math.min(maxWidth, Math.max(SIDE_PANEL_MIN_WIDTH, fixedRight - pointerEvent.clientX));
  }

  function onMove(moveEvent) {
    panelEl.style.width = `${widthFor(moveEvent)}px`;
  }

  function onUp(upEvent) {
    resizeHandleEl.removeEventListener('pointermove', onMove);
    resizeHandleEl.removeEventListener('pointerup', onUp);
    resizeHandleEl.classList.remove('mlpr-resize-active');
    document.body.style.userSelect = previousUserSelect;
    updateSettings({ sidePanelWidth: widthFor(upEvent) });
  }

  resizeHandleEl.addEventListener('pointermove', onMove);
  resizeHandleEl.addEventListener('pointerup', onUp);
});

// This module (imported by app.js, evaluated before app.js's own top-level
// code including the WebGL-dependent `new maplibregl.Map(...)`) is the
// first reliable place to touch the DOM regardless of whether the map
// itself ever comes up -- <html lang> and the close buttons' aria-label
// both need to be set unconditionally, not tucked behind map init.
document.documentElement.lang = getLanguage();
closeBtn.setAttribute('aria-label', t('close'));
modalCloseBtn.setAttribute('aria-label', t('close'));

// Bottom-left "i" credits button (index.html's #mlpr-corner-info) -- a
// click-toggled panel, not a CSS :hover tooltip like Settings' own
// .mlpr-info-icon hints, because this one's content is real links
// (nested <a> inside a <button> is invalid HTML and unreliable for
// clicks/keyboard focus across browsers) and needs to work reliably on
// touch too, where hover doesn't really apply. Wired up here rather than
// in app.js for the same reason as the lang/aria-label setup just above --
// this module runs regardless of whether the WebGL-dependent map ever
// comes up.
{
  const creditsToggle = document.getElementById('mlpr-credits-toggle');
  const creditsPanel = document.getElementById('mlpr-credits-panel');
  creditsToggle.setAttribute('aria-label', t('creditsLabel'));
  document.getElementById('mlpr-credits-heading').textContent = t('specialThanksTo');

  function closeCreditsPanel() {
    creditsPanel.classList.add('hidden');
    creditsToggle.setAttribute('aria-expanded', 'false');
  }

  creditsToggle.addEventListener('click', (event) => {
    event.stopPropagation();
    const isOpen = !creditsPanel.classList.contains('hidden');
    if (isOpen) {
      closeCreditsPanel();
    } else {
      creditsPanel.classList.remove('hidden');
      creditsToggle.setAttribute('aria-expanded', 'true');
    }
  });

  document.addEventListener('click', (event) => {
    if (creditsPanel.classList.contains('hidden')) return;
    if (creditsPanel.contains(event.target) || event.target === creditsToggle) return;
    closeCreditsPanel();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !creditsPanel.classList.contains('hidden')) closeCreditsPanel();
  });
}

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
  panelEl.classList.toggle('mlpr-panel-fill', !!entry.fill);
  panelEl.setAttribute('aria-hidden', 'false');
  applySidePanelWidth();
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

export async function openFullscreenModal(name) {
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
  modalEl.classList.toggle('mlpr-panel-fill', !!entry.fill);
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
