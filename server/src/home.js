import { getConfig, setConfig, deleteConfig } from './db.js';

let autoDetected = null;

export function setAutoDetectedHome(receiverInfo) {
  if (receiverInfo && typeof receiverInfo.lat === 'number' && typeof receiverInfo.lon === 'number') {
    autoDetected = { lat: receiverInfo.lat, lon: receiverInfo.lon };
  }
}

function getManualOverride() {
  const lat = getConfig('homeLat');
  const lon = getConfig('homeLon');
  if (lat === null || lon === null) return null;
  return { lat: Number(lat), lon: Number(lon) };
}

export function getEffectiveHome() {
  const manual = getManualOverride();
  if (manual) return { ...manual, source: 'manual' };
  if (autoDetected) return { ...autoDetected, source: 'receiver.json' };
  return null;
}

export function setManualHome(lat, lon) {
  setConfig('homeLat', String(lat));
  setConfig('homeLon', String(lon));
}

export function clearManualHome() {
  deleteConfig('homeLat');
  deleteConfig('homeLon');
}
