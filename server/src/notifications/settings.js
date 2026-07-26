import { randomInt } from 'node:crypto';
import { getConfig, setConfig, getConfigJSON, setConfigJSON } from '../db.js';

const SETTINGS_KEY = 'notificationSettings';
const NTFY_TOPIC_KEY = 'ntfyTopic';
// No 0/o or 1/l/i — those are the pairs people mistype when copying a code by hand.
const TOPIC_CHARSET = '23456789abcdefghjkmnpqrstuvwxyz';
const TOPIC_LENGTH = 8;

const DEFAULT_SETTINGS = {
  squawkEnabled: true,
  squawkCodes: { 7500: true, 7600: true, 7700: true },
  firstSeenEnabled: true,
  rangeRecordEnabled: true,
};

export function getNotificationSettings() {
  return { ...DEFAULT_SETTINGS, ...getConfigJSON(SETTINGS_KEY, {}) };
}

export function updateNotificationSettings(patch) {
  const current = getNotificationSettings();
  const next = {
    ...current,
    ...patch,
    squawkCodes: { ...current.squawkCodes, ...(patch.squawkCodes ?? {}) },
  };
  setConfigJSON(SETTINGS_KEY, next);
  return next;
}

function generateTopic() {
  let topic = '';
  for (let i = 0; i < TOPIC_LENGTH; i += 1) {
    topic += TOPIC_CHARSET[randomInt(TOPIC_CHARSET.length)];
  }
  return topic;
}

export function getNtfyTopic() {
  let topic = getConfig(NTFY_TOPIC_KEY);
  if (!topic) {
    topic = generateTopic();
    setConfig(NTFY_TOPIC_KEY, topic);
  }
  return topic;
}

export function regenerateNtfyTopic() {
  const topic = generateTopic();
  setConfig(NTFY_TOPIC_KEY, topic);
  return topic;
}
