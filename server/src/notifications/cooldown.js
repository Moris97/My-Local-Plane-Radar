const DEFAULT_COOLDOWN_MS = 30 * 60 * 1000;

const lastNotifiedAt = new Map();

export function isOnCooldown(ruleType, hex, cooldownMs = DEFAULT_COOLDOWN_MS) {
  const last = lastNotifiedAt.get(`${ruleType}:${hex}`);
  return last !== undefined && Date.now() - last < cooldownMs;
}

export function markNotified(ruleType, hex) {
  lastNotifiedAt.set(`${ruleType}:${hex}`, Date.now());
}

export function pruneCooldowns(maxAgeMs = 24 * 60 * 60 * 1000) {
  const now = Date.now();
  for (const [key, at] of lastNotifiedAt) {
    if (now - at > maxAgeMs) lastNotifiedAt.delete(key);
  }
}

export function resetCooldowns() {
  lastNotifiedAt.clear();
}
