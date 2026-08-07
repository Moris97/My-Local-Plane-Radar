// On-map toast notifications (v2.1.20): the visual twin of the ntfy/MQTT
// notification engine (server/src/notifications/rules.js) -- every rule
// that already sends a push notification now also raises a dismissible
// card here, so a radar meant to be watched doesn't stay silent about the
// exact things it's designed to flag. Fed by the WebSocket's `type:
// 'notification'` messages (app.js's handleSnapshot forwards them to
// handleNotificationEvent below) -- this module owns rendering, lifecycle,
// and the tab-title unread badge; it has zero knowledge of the map or
// marker DOM (see app.js's own applyTimedAlert for the red-glow half of
// this feature, which does need that).
//
// Deliberately does NOT re-derive "should this fire" from raw aircraft
// data -- every event arriving here already passed rules.js's own
// enabled-setting/cooldown checks server-side, the same single source of
// truth the ntfy/MQTT sends already share. A second, independently-
// re-evaluated copy of squawk/watchlist matching client-side is exactly
// the "two mechanisms, guaranteed to drift" shape CLAUDE.md's own history
// warns against repeatedly.
import { t } from './i18n.js';
import { requestSelect } from './radar-state.js';
import { formatAltitude, formatSpeed, formatDistance } from './units.js';
import { getSettings } from './settings-state.js';
import { onPanelLayoutChange, isSidePanelLayout } from './panels.js';
import { escapeHtml } from './html-escape.js';

const TOAST_LIFETIME_MS = 30000;
// Caps how many render at once -- TODO.md's own known rough edge ("on a
// fresh install, every aircraft currently in range fires a first-seen
// notification") means a real burst of a few dozen events in the first
// couple of poll ticks is an expected case, not a hypothetical one, and
// showing all of them stacked at once would be pure clutter. Anything past
// this waits in pendingQueue and renders (with a *fresh* full lifetime,
// see renderNext) as a slot frees up; the "+N more" chip shows how many
// are still waiting.
const MAX_VISIBLE_TOASTS = 5;
const PANEL_GAP_PX = 10;
const DEFAULT_INSET_PX = 6;

const stackEl = document.getElementById('mlpr-toast-stack');

// visible: rendered cards, in display order (oldest first, newest appended
// last -- see CSS, new cards animate in at the bottom of the stack).
// pending: events bumped past MAX_VISIBLE_TOASTS, awaiting a slot.
const visible = [];
const pending = [];
let nextId = 1;

const originalTitle = document.title;
// Toasts that arrived while the tab was hidden and haven't been "seen"
// yet -- cleared the moment the tab regains visibility (standard tab-badge
// UX, e.g. Gmail/Slack), independent of whether each toast has since been
// individually dismissed or is still sitting in pendingQueue.
let unseenCount = 0;

function updateTitleBadge() {
  document.title = unseenCount > 0 ? `(${unseenCount}) ${originalTitle}` : originalTitle;
}

// ---- Placement -------------------------------------------------------
//
// Explicit request: top-right on desktop, shifting to sit beside #panel
// (List/Settings/aircraft-details) when it's open rather than being
// covered by it -- the hardest of the placement options analysed, but the
// one that never covers the map or the panel. #fullscreen-modal (Stats) is
// always full-width even on desktop (see panels.js/CLAUDE.md's PANELS vs
// FULLSCREEN_MODALS split), so there is no "beside" for it -- the stack
// just floats above it instead (see the CSS z-index), the same way a phone
// notification overlays whatever app is in the foreground. On narrow
// screens (below panels.js's own SIDE_PANEL_LAYOUT_QUERY breakpoint,
// where #panel becomes a bottom sheet instead of a right-docked column)
// the stack becomes a full-width banner from the top instead -- requested
// explicitly ("na telefonie niech się pojawia na górze").
function updatePlacement() {
  const panelEl = document.getElementById('panel');
  const wide = isSidePanelLayout();
  stackEl.classList.toggle('mlpr-toast-stack-mobile', !wide);
  stackEl.classList.toggle('mlpr-toast-stack-desktop', wide);

  if (!wide) {
    stackEl.style.right = '';
    return;
  }

  const panelOpen = panelEl && !panelEl.classList.contains('hidden');
  if (panelOpen) {
    const panelLeft = panelEl.getBoundingClientRect().left;
    stackEl.style.right = `${Math.max(DEFAULT_INSET_PX, window.innerWidth - panelLeft + PANEL_GAP_PX)}px`;
  } else {
    stackEl.style.right = `${DEFAULT_INSET_PX}px`;
  }
}

onPanelLayoutChange(updatePlacement);
window.addEventListener('resize', updatePlacement);

// ---- Auto-dismiss, paused while the tab is hidden ---------------------
//
// A toast created while already hidden is born pre-paused: no timer starts
// until the tab is actually looked at, so a burst that arrives entirely
// while backgrounded doesn't silently expire before anyone sees it (the
// whole point of the title badge above).
function armTimer(toast) {
  toast.timerId = setTimeout(() => dismiss(toast.id), toast.remainingMs);
  toast.resumedAt = Date.now();
}

function pauseTimer(toast) {
  if (toast.timerId === null) return;
  clearTimeout(toast.timerId);
  toast.timerId = null;
  toast.remainingMs = Math.max(0, toast.remainingMs - (Date.now() - toast.resumedAt));
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    for (const toast of visible) pauseTimer(toast);
    return;
  }
  unseenCount = 0;
  updateTitleBadge();
  for (const toast of visible) {
    if (toast.timerId !== null) continue; // never paused (created while visible, still running)
    if (toast.remainingMs <= 0) {
      dismiss(toast.id);
    } else {
      armTimer(toast);
    }
  }
});

// ---- Content per kind ---------------------------------------------------

function aircraftSummaryLine(aircraft, units) {
  if (!aircraft) return '';
  const parts = [aircraft.flight?.trim() || aircraft.hex];
  if (aircraft.registration) parts.push(aircraft.registration);
  if (aircraft.typeCode) parts.push(aircraft.typeCode);
  if (aircraft.onGround) {
    parts.push(t('onGround'));
  } else {
    const alt = formatAltitude(aircraft.altitude, units);
    if (alt) parts.push(alt);
  }
  const speed = formatSpeed(aircraft.speed, units);
  if (speed) parts.push(speed);
  return parts.join(' · ');
}

const SQUAWK_MEANING_KEYS = { 7500: 'squawkMeaningHijack', 7600: 'squawkMeaningRadioFailure', 7700: 'squawkMeaningEmergency' };
const WATCH_FIELD_KEYS = { type: 'watchType', registration: 'watchRegistration', flight: 'watchFlight' };

// tags: CSS hooks (mlpr-toast-<tag>) for the accent color per kind -- see
// style.css. { title, body } are plain strings, already translated;
// dangerous parts (aircraft identity) are escaped by renderToast, not here.
function buildContent(event) {
  const { units } = getSettings();
  switch (event.kind) {
    case 'squawk': {
      const meaningKey = SQUAWK_MEANING_KEYS[event.squawk];
      const meaning = meaningKey ? t(meaningKey) : event.squawkMeaning;
      return {
        tag: 'squawk',
        title: `${t('toastSquawkTitle').replace('{code}', event.squawk)} — ${meaning}`,
        body: aircraftSummaryLine(event.aircraft, units),
      };
    }
    case 'first_seen':
      return { tag: 'first-seen', title: t('toastFirstSeenTitle'), body: aircraftSummaryLine(event.aircraft, units) };
    case 'watchlist':
      return {
        tag: 'watched',
        title: t('toastWatchedTitle'),
        body: aircraftSummaryLine(event.aircraft, units),
        detail: t('toastWatchedMatch')
          .replace('{field}', t(WATCH_FIELD_KEYS[event.matchedType] ?? 'watchType'))
          .replace('{value}', event.matchedValue ?? ''),
      };
    case 'range_record':
      return {
        tag: 'range-record',
        title: t('toastRangeRecordTitle'),
        body: aircraftSummaryLine(event.aircraft, units),
        detail: t('toastRangeRecordBody')
          .replace('{km}', formatDistance(event.rangeKm, units) ?? `${event.rangeKm} km`)
          .replace('{previous}', formatDistance(event.previousRangeKm, units) ?? `${event.previousRangeKm} km`),
      };
    case 'receiver_silence':
      return {
        tag: 'receiver-silence',
        title: t('toastReceiverSilenceTitle'),
        body: t('toastReceiverSilenceBody').replace('{hours}', String(event.hours)),
      };
    default:
      return null;
  }
}

// ---- Rendering ------------------------------------------------------

function renderToast(toast) {
  const content = buildContent(toast.event);
  if (!content) return null;

  const el = document.createElement('div');
  el.className = `mlpr-toast mlpr-toast-${content.tag}`;
  // No role/aria-live of its own -- #mlpr-toast-stack's own role="log"
  // aria-live="polite" (index.html) already covers new items being added
  // to it; a second live region nested inside is a known ARIA anti-pattern
  // (risks a double announcement) rather than an extra safety net.
  // Clickable (select the aircraft) only when the event actually names one
  // -- receiver_silence has no aircraft at all, nothing to select.
  if (toast.event.hex) el.classList.add('mlpr-toast-clickable');

  el.innerHTML = `
    <div class="mlpr-toast-body">
      <p class="mlpr-toast-title">${escapeHtml(content.title)}</p>
      <p class="mlpr-toast-summary">${escapeHtml(content.body)}</p>
      ${content.detail ? `<p class="mlpr-toast-detail">${escapeHtml(content.detail)}</p>` : ''}
    </div>
    <button type="button" class="mlpr-toast-close" aria-label="${escapeHtml(t('toastDismiss'))}">&times;</button>
  `;

  el.querySelector('.mlpr-toast-close').addEventListener('click', (domEvent) => {
    domEvent.stopPropagation();
    dismiss(toast.id);
  });

  if (toast.event.hex) {
    el.addEventListener('click', () => {
      // Same request/handler pair list.js's own row clicks use (radar-
      // state.js's requestSelect -> app.js's selectAndCenter) -- centers
      // the map on it too, not just a bare select: unlike a marker you
      // physically clicked, a toast-referenced aircraft is routinely
      // off-screen (a first-seen contact at the edge of range, a watch-
      // list match inside a trigger area far from home), so "the same
      // effect as clicking the aircraft" only means something if it's
      // brought into view first.
      requestSelect(toast.event.hex);
      dismiss(toast.id);
    });
  }

  return el;
}

function renderNext() {
  // Also reached with nothing to promote (a dismiss when pending is
  // already empty, or a new arrival while the stack is still full) --
  // updateOverflowChip() still needs to run either way, since the pending
  // count it displays can change without anything getting rendered.
  if (visible.length >= MAX_VISIBLE_TOASTS || pending.length === 0) {
    updateOverflowChip();
    return;
  }
  const toast = pending.shift();
  const el = renderToast(toast);
  if (!el) {
    renderNext();
    return;
  }
  toast.el = el;
  toast.remainingMs = TOAST_LIFETIME_MS;
  toast.timerId = null;
  visible.push(toast);
  stackEl.appendChild(el);
  // Entrance animation: added a frame after insertion so the initial state
  // (set in CSS on .mlpr-toast itself) actually paints before transitioning,
  // rather than the browser coalescing both into one state with no visible
  // motion.
  requestAnimationFrame(() => el.classList.add('mlpr-toast-visible'));
  if (!document.hidden) armTimer(toast);
  updateOverflowChip();
}

function updateOverflowChip() {
  let chip = stackEl.querySelector('.mlpr-toast-overflow');
  if (pending.length === 0) {
    chip?.remove();
    return;
  }
  const text = t('toastMoreCount').replace('{count}', String(pending.length));
  if (!chip) {
    chip = document.createElement('div');
    chip.className = 'mlpr-toast-overflow';
    stackEl.appendChild(chip);
  } else {
    stackEl.appendChild(chip); // keep it last
  }
  chip.textContent = text;
}

function dismiss(id) {
  const index = visible.findIndex((toast) => toast.id === id);
  if (index === -1) return;
  const [toast] = visible.splice(index, 1);
  if (toast.timerId !== null) clearTimeout(toast.timerId);
  toast.el.classList.remove('mlpr-toast-visible');
  toast.el.classList.add('mlpr-toast-leaving');
  // Removed only after the exit transition actually finishes playing --
  // but a toast dismissed within the same frame it was created in (the X
  // clicked before the entrance rAF ever added .mlpr-toast-visible) is
  // already sitting at opacity 0, and going 0 -> 0 fires no `transitionend`
  // at all, which would otherwise strand it in the DOM forever. The
  // setTimeout is a fallback for exactly that case -- remove() on an
  // already-detached node is a harmless no-op, so both firing is fine.
  toast.el.addEventListener('transitionend', () => toast.el.remove(), { once: true });
  setTimeout(() => toast.el.remove(), 400);
  renderNext();
}

// ---- Entry point, called by app.js per WS 'notification' message -------

export function handleNotificationEvent(event) {
  const toast = { id: nextId++, event, el: null, timerId: null, remainingMs: TOAST_LIFETIME_MS, resumedAt: 0 };

  if (document.hidden) unseenCount += 1;
  updateTitleBadge();

  pending.push(toast);
  renderNext();
}

export function initNotificationsUi() {
  updatePlacement();
}
