import fs from 'node:fs/promises';
import { config } from './config.js';

/** Is the local whisper sidecar up? Returns its /health payload or null. */
export async function sttHealth(timeoutMs = 2000) {
  try {
    const res = await fetch(`${config.sttUrl}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

/**
 * Release Whisper's VRAM so the note-writing LLM can have the whole GPU.
 * On a 12GB card the two models together leave almost no headroom, and they are
 * never needed at once. The sidecar reloads on demand, so this is always safe.
 */
export async function unloadStt() {
  try {
    const res = await fetch(`${config.sttUrl}/unload`, {
      method: 'POST',
      signal: AbortSignal.timeout(30_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Warm the model up before a meeting so the first speaker isn't clipped. */
export async function warmStt() {
  try {
    const res = await fetch(`${config.sttUrl}/load`, {
      method: 'POST',
      signal: AbortSignal.timeout(300_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Send one utterance wav to the local whisper sidecar. Returns the text. */
export async function transcribeFile(wavPath) {
  const buf = await fs.readFile(wavPath);

  const form = new FormData();
  form.append('file', new Blob([buf], { type: 'audio/wav' }), 'utterance.wav');

  const res = await fetch(`${config.sttUrl}/transcribe`, {
    method: 'POST',
    body: form,
    // Long utterances on CPU-only machines can genuinely take a while.
    signal: AbortSignal.timeout(180_000),
  });

  if (!res.ok) {
    throw new Error(`STT service returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }

  const data = await res.json();
  return (data.text || '').trim();
}
