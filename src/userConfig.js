import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { ensureDir } from './utils.js';

export const DELIVERY_MODES = ['me', 'everyone', 'channel'];
const DEFAULT_DELIVERY = { mode: 'me', channelId: null };

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

/** A user's saved default for how meeting notes should be delivered in this guild. */
export async function getUserDelivery(guildId, userId) {
  const map = await load();
  return map.get(key(guildId, userId)) || DEFAULT_DELIVERY;
}

export async function setUserDelivery(guildId, userId, { mode, channelId }) {
  const map = await load();
  map.set(key(guildId, userId), { mode, channelId: channelId || null });
  await persist();
}
