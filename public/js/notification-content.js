// kind -> translated title/body/detail/accent-tag, shared by the live
// on-map toast (notifications-ui.js) and the Stats "Historia zdarzeń" table
// (stats.js) -- one mapping, not two that could drift apart.
//
// Deliberately its own leaf module, not defined inside notifications-ui.js:
// that file also imports panels.js, and panels.js imports stats.js (for
// the Stats fullscreen-modal entry) -- if stats.js imported buildContent
// straight from notifications-ui.js, the resulting cycle
// (panels.js -> stats.js -> notifications-ui.js -> panels.js) breaks
// module evaluation order (a real, reproduced bug: notifications-ui.js's
// own top-level onPanelLayoutChange(...) call ran before panels.js had
// reached its own `const panelLayoutListeners = new Set()`, throwing
// "Cannot access 'panelLayoutListeners' before initialization"). This
// module has no dependency on panels.js/radar-state.js at all, so neither
// importer can ever cycle back through it.
import { t } from './i18n.js';
import { formatAltitude, formatSpeed, formatDistance } from './units.js';
import { getSettings } from './settings-state.js';

export function aircraftSummaryLine(aircraft, units) {
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

// tags: CSS hooks (mlpr-toast-<tag> for the accent color) -- see style.css.
// { title, body } are plain strings, already translated; dangerous parts
// (aircraft identity) are escaped by the caller (renderToast/eventRowHtml),
// not here.
export function buildContent(event) {
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
    case 'circling':
      return { tag: 'circling', title: t('toastCirclingTitle'), body: aircraftSummaryLine(event.aircraft, units) };
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
