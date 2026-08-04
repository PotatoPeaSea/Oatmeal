import { config, isCloud } from './config.js';

/**
 * One chat interface over two very different backends.
 *
 *   cloud (default)  OpenRouter -> nvidia/nemotron-3-ultra-550b-a55b:free
 *                    1M context, so a whole meeting fits in a single pass.
 *   local  --local   Ollama -> qwen3.5:9b on the local GPU. Fully offline,
 *                    but shares VRAM with Whisper (see the handoff in session.js).
 *
 * Both are reasoning-capable models; both are told not to reason, because we
 * want the finished document rather than the deliberation.
 */

/** Remove <think> blocks in case a model emits them inline anyway. */
export function stripThinking(text) {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/^<think>[\s\S]*$/i, '')
    .trim();
}

// ---------------------------------------------------------------- local -----

async function ollamaChat(messages, { temperature, numCtx, signal }) {
  const call = async (includeThink) => {
    const body = {
      model: config.ollamaModel,
      messages,
      stream: false,
      options: { temperature, num_ctx: numCtx },
    };
    if (includeThink) body.think = false;

    const res = await fetch(`${config.ollamaUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: signal ?? AbortSignal.timeout(600_000),
    });
    if (!res.ok) {
      const err = new Error(`Ollama returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  };

  let data;
  try {
    data = await call(true);
  } catch (err) {
    // Older Ollama builds / non-reasoning models 400 on an unknown `think` field.
    if (err.status === 400) data = await call(false);
    else throw err;
  }
  return stripThinking(data?.message?.content || '');
}

// ---------------------------------------------------------------- cloud -----

async function openrouterChat(messages, { temperature, signal }) {
  const res = await fetch(`${config.openrouterUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.openrouterKey}`,
      // OpenRouter uses these for attribution on its dashboard; both optional.
      'HTTP-Referer': 'https://github.com/local/oatmeal',
      'X-Title': 'Oatmeal',
    },
    body: JSON.stringify({
      model: config.openrouterModel,
      messages,
      temperature,
      // Nemotron is a reasoning model. We want the document, not the thinking.
      reasoning: { enabled: false, exclude: true },
    }),
    signal: signal ?? AbortSignal.timeout(600_000),
  });

  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    const err = new Error(`OpenRouter returned ${res.status}: ${detail}`);
    err.status = res.status;
    throw err;
  }

  const data = await res.json();
  // OpenRouter surfaces upstream provider failures in a 200 body, so the HTTP
  // status alone doesn't tell us whether we were throttled.
  if (data.error) {
    const err = new Error(`OpenRouter: ${data.error.message || JSON.stringify(data.error)}`);
    err.status = data.error.code;
    throw err;
  }

  const choice = data.choices?.[0];
  return stripThinking(choice?.message?.content || '');
}

/**
 * Did this failure mean "come back later" rather than "you asked for something
 * impossible"? The free Nemotron pool answers in several dialects: a plain 429,
 * an OpenRouter body with `code: 429`, and a 200 carrying
 * "Upstream error from Nvidia: ResourceExhausted: Worker local total request
 * limit reached (32/32)".
 */
function isRateLimited(err) {
  if (err?.status === 429 || err?.status === 503) return true;
  return /rate.?limit|resourceexhausted|quota|too many requests|overloaded|capacity/i.test(
    err?.message || ''
  );
}

// -------------------------------------------------------- cloud fallback -----

/**
 * Google's OpenAI-compatible endpoint, used only when OpenRouter throttles us.
 * Deliberately does not send `reasoning`: that field is OpenRouter's, and this
 * surface rejects unknown parameters.
 */
async function geminiChat(messages, { temperature, signal }) {
  const res = await fetch(`${config.geminiUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.geminiKey}`,
    },
    body: JSON.stringify({ model: config.geminiModel, messages, temperature }),
    signal: signal ?? AbortSignal.timeout(600_000),
  });

  if (!res.ok) {
    const err = new Error(`Gemini returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }

  const data = await res.json();
  if (data.error) throw new Error(`Gemini: ${data.error.message || JSON.stringify(data.error)}`);
  return stripThinking(data.choices?.[0]?.message?.content || '');
}

// --------------------------------------------------------------- shared -----

/** Is a second cloud backend available to catch throttling? */
export const hasFallback = () => isCloud() && Boolean(config.geminiKey);

/**
 * Send a chat completion to whichever backend is configured.
 *
 * In cloud mode a throttled request is retried once against Gemini rather than
 * failing. A meeting costs several calls — every rolling section summary plus
 * the consolidation — so on a contended free endpoint the odds of hitting the
 * limit at least once are meaningful, and losing any one call loses notes.
 */
export async function llmChat(messages, { temperature = 0.3, numCtx = 16384, signal } = {}) {
  if (!isCloud()) return ollamaChat(messages, { temperature, numCtx, signal });

  try {
    return await openrouterChat(messages, { temperature, signal });
  } catch (err) {
    if (!hasFallback() || !isRateLimited(err)) throw err;
    console.warn(`[llm] OpenRouter throttled (${err.message}) — falling back to ${config.geminiModel}`);
    return geminiChat(messages, { temperature, signal });
  }
}

/** Human-readable backend label for logs and /status. */
export function llmLabel() {
  if (!isCloud()) return `Ollama · ${config.ollamaModel}`;
  return (
    `OpenRouter · ${config.openrouterModel}` +
    (hasFallback() ? ` (fallback: ${config.geminiModel})` : '')
  );
}

/**
 * How much transcript we can hand the model in one go.
 * Nemotron's 1M window swallows any realistic meeting, so cloud mode never
 * needs to fall back to chunked map-reduce for context reasons.
 */
export function singlePassLimit() {
  return isCloud() ? 600_000 : 24_000;
}

/** Chunk size used when a transcript does have to be split. */
export function chunkChars() {
  return isCloud() ? 60_000 : 12_000;
}

/**
 * Free the local model's VRAM once notes are written. No-op in cloud mode,
 * where nothing is resident on this machine.
 */
export async function releaseLlm() {
  if (isCloud()) return false;
  try {
    const res = await fetch(`${config.ollamaUrl}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: config.ollamaModel, keep_alive: 0 }),
      signal: AbortSignal.timeout(30_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Is the configured backend reachable and usable? */
export async function llmHealth(timeoutMs = 5000) {
  if (isCloud()) {
    if (!config.openrouterKey) return { ok: false, detail: 'OPENROUTER_API_KEY not set' };
    try {
      const res = await fetch(`${config.openrouterUrl}/key`, {
        headers: { authorization: `Bearer ${config.openrouterKey}` },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) return { ok: false, detail: `key check returned ${res.status}` };
      const data = await res.json();
      const limit = data?.data?.limit;
      const used = data?.data?.usage;
      // The fallback only catches throttling, never a bad key, so it does not
      // make an unhealthy primary healthy — it is reported, not counted.
      return {
        ok: true,
        detail:
          (limit == null ? 'key valid (no credit limit)' : `key valid (${used ?? 0}/${limit} used)`) +
          (hasFallback() ? `; ${config.geminiModel} standing by for rate limits` : ''),
      };
    } catch (err) {
      return { ok: false, detail: err.message };
    }
  }

  try {
    const res = await fetch(`${config.ollamaUrl}/api/tags`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { ok: false, detail: `Ollama returned ${res.status}` };
    const data = await res.json();
    const models = (data.models || []).map((m) => m.name);
    return models.includes(config.ollamaModel)
      ? { ok: true, detail: 'model pulled' }
      : { ok: false, detail: `run: ollama pull ${config.ollamaModel}` };
  } catch (err) {
    return { ok: false, detail: err.message };
  }
}
