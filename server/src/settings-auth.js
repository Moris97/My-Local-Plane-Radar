import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { getConfig, getConfigJSON, setConfigJSON, deleteConfig } from './db.js';

const PASSWORD_KEY = 'settingsPasswordHash';
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

const activeTokens = new Map();

// Brute-force guard on password verification (the login endpoint, and the
// change-password endpoint's own currentPassword check -- both call
// verifyPassword() and were equally guessable with unlimited attempts
// before this). Keyed by request IP, in memory only (same "lost on
// restart is fine" tradeoff as activeTokens) -- a home LAN app doesn't
// need anything sturdier than a fixed threshold/lockout window, no
// exponential backoff bookkeeping.
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MS = 5 * 60 * 1000;

const failedAttempts = new Map();

export function isLockedOut(ip) {
  const entry = failedAttempts.get(ip);
  if (!entry || !entry.lockedUntil) return false;
  if (Date.now() >= entry.lockedUntil) {
    failedAttempts.delete(ip);
    return false;
  }
  return true;
}

export function recordFailedAttempt(ip) {
  const entry = failedAttempts.get(ip) ?? { count: 0, lockedUntil: null };
  entry.count += 1;
  if (entry.count >= MAX_FAILED_ATTEMPTS) entry.lockedUntil = Date.now() + LOCKOUT_MS;
  failedAttempts.set(ip, entry);
}

export function recordSuccessfulAttempt(ip) {
  failedAttempts.delete(ip);
}

export function pruneLoginAttempts() {
  const now = Date.now();
  for (const [ip, entry] of failedAttempts) {
    if (entry.lockedUntil && now >= entry.lockedUntil) failedAttempts.delete(ip);
  }
}

function hashPassword(password, salt) {
  return scryptSync(password, salt, 64).toString('hex');
}

export function isPasswordSet() {
  return getConfig(PASSWORD_KEY) !== null;
}

export function setPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = hashPassword(password, salt);
  setConfigJSON(PASSWORD_KEY, { salt, hash });
  activeTokens.clear();
}

export function removePassword() {
  deleteConfig(PASSWORD_KEY);
  activeTokens.clear();
}

export function verifyPassword(password) {
  const stored = getConfigJSON(PASSWORD_KEY, null);
  if (!stored || typeof password !== 'string') return false;

  const attempt = Buffer.from(hashPassword(password, stored.salt), 'hex');
  const expected = Buffer.from(stored.hash, 'hex');
  return attempt.length === expected.length && timingSafeEqual(attempt, expected);
}

export function issueToken() {
  const token = randomBytes(24).toString('hex');
  activeTokens.set(token, Date.now() + TOKEN_TTL_MS);
  return token;
}

export function isValidToken(token) {
  if (!token) return false;
  const expiresAt = activeTokens.get(token);
  if (expiresAt === undefined) return false;
  if (Date.now() > expiresAt) {
    activeTokens.delete(token);
    return false;
  }
  return true;
}

export function pruneTokens() {
  const now = Date.now();
  for (const [token, expiresAt] of activeTokens) {
    if (now > expiresAt) activeTokens.delete(token);
  }
}

export function clearAllTokens() {
  activeTokens.clear();
}
