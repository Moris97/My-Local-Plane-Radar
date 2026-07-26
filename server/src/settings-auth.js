import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { getConfig, getConfigJSON, setConfigJSON, deleteConfig } from './db.js';

const PASSWORD_KEY = 'settingsPasswordHash';
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

const activeTokens = new Map();

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
