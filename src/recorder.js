import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { EndBehaviorType } from '@discordjs/voice';
import prism from 'prism-media';
import { config } from './config.js';

// Discord always sends 48kHz stereo Opus. Whisper wants 16kHz mono.
const DISCORD_RATE = 48000;
const DISCORD_CHANNELS = 2;
const BYTES_PER_SAMPLE = 2;
const BYTES_PER_MS = (DISCORD_RATE * DISCORD_CHANNELS * BYTES_PER_SAMPLE) / 1000;

/**
 * Pipes raw PCM through ffmpeg into a 16kHz mono wav file.
 * Writing to a real file (rather than stdout) lets ffmpeg seek back and patch
 * the RIFF header with the final length, which it cannot do on a pipe.
 */
export function pcmToWavFile(pcmStream, outPath) {
  return new Promise((resolve, reject) => {
    const ff = spawn(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel', 'error',
        '-f', 's16le',
        '-ar', String(DISCORD_RATE),
        '-ac', String(DISCORD_CHANNELS),
        '-i', 'pipe:0',
        '-ar', '16000',
        '-ac', '1',
        '-c:a', 'pcm_s16le',
        '-y', outPath,
      ],
      { stdio: ['pipe', 'ignore', 'pipe'] }
    );

    let stderr = '';
    ff.stderr.on('data', (d) => (stderr += d.toString()));
    ff.on('error', (err) =>
      reject(
        new Error(
          `Could not run ffmpeg (${err.message}). Make sure ffmpeg is installed and on PATH.`
        )
      )
    );
    ff.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${stderr.trim()}`))
    );

    // EPIPE here just means ffmpeg died first; the 'close' handler reports why.
    pipeline(pcmStream, ff.stdin).catch(() => {});
  });
}

/**
 * Subscribes to every speaker in the voice channel and turns each contiguous
 * burst of speech into one .wav file, handed to `onUtterance`.
 *
 * Discord gives us a separate Opus stream per user, which means speaker
 * attribution is exact — no diarisation guesswork needed.
 *
 * @returns {() => void} detach function
 */
export function startCapture(session, onUtterance) {
  const receiver = session.connection.receiver;
  const active = new Set();
  let detached = false;

  const onSpeakingStart = async (userId) => {
    if (detached || active.has(userId)) return;

    // Voice-state events usually populate the cache, but a user who was already
    // in the channel before we joined may not be there yet.
    const member =
      session.guild.members.cache.get(userId) ??
      (await session.guild.members.fetch(userId).catch(() => null));
    if (member?.user?.bot) return; // don't transcribe ourselves or other bots

    active.add(userId);
    const startedAt = Date.now();
    const speaker =
      member?.nickname || member?.user?.globalName || member?.user?.username || `user-${userId}`;

    const seq = session.nextUtteranceSeq();
    const wavPath = path.join(session.audioDir, `${String(seq).padStart(5, '0')}-${userId}.wav`);

    const opusStream = receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: config.silenceMs },
    });

    const decoder = new prism.opus.Decoder({
      frameSize: 960,
      channels: DISCORD_CHANNELS,
      rate: DISCORD_RATE,
    });

    // Measure speech length from decoded PCM volume, which is more honest than
    // wall-clock: the trailing silence window isn't counted.
    let pcmBytes = 0;
    decoder.on('data', (chunk) => (pcmBytes += chunk.length));

    opusStream.on('error', () => decoder.destroy());

    try {
      await pcmToWavFile(opusStream.pipe(decoder), wavPath);
      const durationMs = pcmBytes / BYTES_PER_MS;

      if (durationMs < config.minUtteranceMs) {
        fs.promises.unlink(wavPath).catch(() => {});
      } else {
        onUtterance({ userId, speaker, startedAt, durationMs, wavPath, seq });
      }
    } catch (err) {
      console.error(`[capture] ${speaker}: ${err.message}`);
      fs.promises.unlink(wavPath).catch(() => {});
    } finally {
      active.delete(userId);
    }
  };

  receiver.speaking.on('start', onSpeakingStart);

  return () => {
    detached = true;
    receiver.speaking.off('start', onSpeakingStart);
  };
}
