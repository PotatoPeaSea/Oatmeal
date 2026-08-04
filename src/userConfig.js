import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { ensureDir } from './utils.js';
import { DEFAULT_FORMAT, isNoteFormat } from './notes.js';

export const DELIVERY_MODES = ['me', 'everyone', 'channel'];
const DEFAULTS = { mode: 'me', channelId: null, format: DEFAULT_FORMAT };

const filePath = path.join(config.root, 'data', 'user-config.json');
const key = (guildId, userId) => `${guildId}:${userId}`;

let cache = null;

async function load() {
  if (cache) return cache;
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    cache = new Map(Object.entries(JSON.parse(raw)));
  } catch {
    cache = new Map();
  }
  return cache;
}

async function persist() {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, JSON.stringify(Object.fromEntries(cache), null, 2), 'utf8');
}

/**
 * A user's saved defaults for this guild: how notes are delivered, and which
 * format they are written in. Anything unrecognised on disk (an older file, or
 * a format that has since been renamed) falls back to the default.
 */
export async function getUserPrefs(guildId, userId) {
  const map = await load();
  const saved = map.get(key(guildId, userId)) || {};
  return {
    mode: DELIVERY_MODES.includes(saved.mode) ? saved.mode : DEFAULTS.mode,
    channelId: saved.channelId || null,
    format: isNoteFormat(saved.format) ? saved.format : DEFAULTS.format,
  };
}

/** Merge a partial update over what is saved, so `/config` can set one field. */
export async function setUserPrefs(guildId, userId, patch) {
  const map = await load();
  const next = { ...(await getUserPrefs(guildId, userId)), ...patch };
  map.set(key(guildId, userId), {
    mode: next.mode,
    channelId: next.channelId || null,
    format: next.format,
  });
  await persist();
  return next;
}
