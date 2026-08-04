import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const bool = (v, fallback) =>
  v === undefined ? fallback : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());

/**
 * Which LLM writes the notes. Cloud is the default; `--local` (or
 * LLM_BACKEND=local) switches to Ollama for a fully offline run.
 * A CLI flag always beats the env var so you can override per-launch.
 */
function resolveBackend() {
  if (process.argv.includes('--local')) return 'local';
  if (process.argv.includes('--cloud')) return 'cloud';
  const env = (process.env.LLM_BACKEND || '').toLowerCase();
  return env === 'local' ? 'local' : 'cloud';
}

export const config = {
  root,
  recordingsDir: path.join(root, 'recordings'),
  notesDir: path.join(root, 'notes'),

  token: process.env.DISCORD_TOKEN,
  clientId: process.env.DISCORD_CLIENT_ID,
  guildId: process.env.DISCORD_GUILD_ID || null,

  sttUrl: (process.env.STT_URL || 'http://127.0.0.1:8756').replace(/\/$/, ''),
  ollamaUrl: (process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/$/, ''),
  ollamaModel: process.env.OLLAMA_MODEL || 'qwen3.5:9b',

  llmBackend: resolveBackend(),
  openrouterKey: process.env.OPENROUTER_API_KEY || '',
  openrouterUrl: (process.env.OPENROUTER_URL || 'https://openrouter.ai/api/v1').replace(/\/$/, ''),
  openrouterModel: process.env.OPENROUTER_MODEL || 'nvidia/nemotron-3-ultra-550b-a55b:free',

  // Optional second cloud backend. Only used when OpenRouter rate-limits us —
  // the free Nemotron endpoint is contended and returns ResourceExhausted under
  // load, which would otherwise lose a whole meeting's notes. Leave the key
  // blank to disable the fallback entirely.
  geminiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '',
  // "Gemini 3 Flash" on the AI Studio quota page, which is the only Gemini 3
  // family model with a listed free allowance. Newer ids (gemini-3.6-flash)
  // answer requests but do not appear in the free-tier quota at all.
  geminiModel: process.env.GEMINI_MODEL || 'gemini-3-flash-preview',
  // Google's OpenAI-compatible surface, so the same request shape works.
  geminiUrl: (
    process.env.GEMINI_URL || 'https://generativelanguage.googleapis.com/v1beta/openai'
  ).replace(/\/$/, ''),

  silenceMs: Number(process.env.SILENCE_MS || 800),
  minUtteranceMs: Number(process.env.MIN_UTTERANCE_MS || 400),
  keepAudio: bool(process.env.KEEP_AUDIO, false),
};

export const isCloud = () => config.llmBackend === 'cloud';

/** Fail loudly at startup rather than mid-meeting. */
export function assertConfig() {
  const missing = ['token', 'clientId'].filter((k) => !config[k]);
  if (missing.length) {
    const names = { token: 'DISCORD_TOKEN', clientId: 'DISCORD_CLIENT_ID' };
    throw new Error(
      `Missing required env var(s): ${missing.map((m) => names[m]).join(', ')}.\n` +
        `Copy .env.example to .env and fill them in.`
    );
  }

  if (isCloud() && !config.openrouterKey) {
    throw new Error(
      'Cloud mode needs OPENROUTER_API_KEY in .env.\n' +
        'Either add the key, or run fully offline with:  npm start -- --local'
    );
  }
}
