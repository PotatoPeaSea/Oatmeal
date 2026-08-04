import fs from 'node:fs/promises';
import path from 'node:path';
import {
  joinVoiceChannel,
  entersState,
  VoiceConnectionStatus,
  getVoiceConnection,
} from '@discordjs/voice';
import { config, isCloud } from './config.js';
import { startCapture } from './recorder.js';
import { transcribeFile, unloadStt } from './transcribe.js';
import {
  generateNotes,
  summariseSection,
  supportsParallelSummarisation,
  emptyNotes,
  DEFAULT_FORMAT,
  SECTION_CHARS,
} from './notes.js';
import { releaseLlm, llmLabel } from './llm.js';
import { ensureDir, safeFilename, formatDuration, formatOffset, SerialQueue } from './utils.js';

/** guildId -> Session. One meeting per server at a time, which matches Discord's own limit. */
const sessions = new Map();

export const getSession = (guildId) => sessions.get(guildId) || null;

export class Session {
  #seq = 0;
  // --- rolling section summarisation (cloud mode only) ---
  #sections = []; // completed section summaries, in meeting order
  #sectionCursor = 0; // utterances[0..cursor) are already in a section
  #sectionCount = 0;
  #sectionFailures = 0;
  #sectionQueue = new SerialQueue();

  constructor({
    guild,
    voiceChannel,
    textChannel,
    requester,
    deliveryMode,
    deliveryChannelId,
    format,
  }) {
    this.guild = guild;
    this.voiceChannel = voiceChannel;
    this.textChannel = textChannel;
    this.requester = requester;
    this.deliveryMode = deliveryMode || 'me';
    this.deliveryChannelId = deliveryChannelId || null;
    this.format = format || DEFAULT_FORMAT;

    this.startedAt = Date.now();
    this.utterances = [];
    this.speakers = new Map(); // userId -> display name
    this.queue = new SerialQueue();
    this.stopping = false;
    this.detach = null;
    this.connection = null;

    // Overridden by the bot so status updates reach the channel.
    this.onProgress = () => {};
    // In cloud mode the LLM is remote, so summarising earlier parts of the
    // meeting can overlap with transcribing the later parts. In local mode both
    // models want the same GPU, so they are strictly sequenced instead.
    this.parallelSummaries = supportsParallelSummarisation();

    const stamp = new Date(this.startedAt).toISOString().replace(/[:.]/g, '-').slice(0, 19);
    this.slug = `${stamp}_${safeFilename(voiceChannel.name)}`;
    this.audioDir = path.join(config.recordingsDir, this.slug);
  }

  nextUtteranceSeq() {
    return ++this.#seq;
  }

  get transcribedCount() {
    return this.utterances.filter((u) => u.text).length;
  }

  /** Utterances we captured but could not transcribe (e.g. the sidecar died). */
  get failedCount() {
    return this.utterances.filter((u) => u.error).length;
  }

  get sectionsStarted() {
    return this.#sectionCount;
  }

  get sectionsDone() {
    return this.#sections.length;
  }

  async start() {
    await ensureDir(this.audioDir);

    this.connection = joinVoiceChannel({
      channelId: this.voiceChannel.id,
      guildId: this.guild.id,
      adapterCreator: this.guild.voiceAdapterCreator,
      selfDeaf: false, // we are here to listen
      selfMute: true,
    });

    this.connection.on(VoiceConnectionStatus.Disconnected, async () => {
      // Could be a move to another channel, or a real drop. Give it a moment.
      try {
        await Promise.race([
          entersState(this.connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(this.connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        if (!this.stopping) {
          console.warn('[session] voice connection lost; finalising notes');
          this.onUnexpectedEnd?.();
        }
      }
    });

    await entersState(this.connection, VoiceConnectionStatus.Ready, 20_000);

    this.detach = startCapture(this, (utt) => this.ingestUtterance(utt));
    sessions.set(this.guild.id, this);
    return this;
  }

  /**
   * Accept one captured utterance and queue it for transcription.
   * Public so the capture -> transcribe -> summarise pipeline can be driven in
   * tests without a live Discord voice connection.
   */
  ingestUtterance(utt) {
    const record = { ...utt, text: '' };
    // Position in `utterances`. Capture pushes here immediately, so entries
    // beyond this index exist but have not been transcribed yet.
    const index = this.utterances.push(record) - 1;
    this.speakers.set(utt.userId, utt.speaker);

    this.queue.add(async () => {
      try {
        record.text = await transcribeFile(utt.wavPath);
      } catch (err) {
        console.error(`[transcribe] ${utt.speaker}: ${err.message}`);
        record.error = err.message;
      }
      // The queue is serial and jobs are added in push order, so everything up
      // to and including `index` is now resolved — but nothing after it is.
      this.#maybeCutSection(index + 1);
    });
  }

  #context() {
    const title = `${this.voiceChannel.name} — ${new Date(this.startedAt).toLocaleDateString()}`;
    return `Meeting: ${title}\nParticipants: ${[...this.speakers.values()].join(', ') || 'unknown'}`;
  }

  /**
   * Once enough new transcript has accumulated, hand that slice off to the LLM
   * while the meeting keeps running. Only ever active in cloud mode.
   */
  #maybeCutSection(resolvedEnd) {
    if (!this.parallelSummaries || this.stopping) return;
    if (resolvedEnd <= this.#sectionCursor) return;

    // Only ever consider utterances that have actually been transcribed.
    // Cutting to utterances.length instead would swallow the not-yet-processed
    // tail and advance the cursor past it, silently dropping it from the notes.
    const slice = this.utterances.slice(this.#sectionCursor, resolvedEnd);
    const chars = slice.reduce((n, u) => n + (u.text?.length || 0), 0);
    if (chars < SECTION_CHARS) return;

    this.#cutSection(this.#sectionCursor, resolvedEnd);
  }

  #cutSection(from, to) {
    const chunk = this.#renderLines(this.utterances.slice(from, to));
    this.#sectionCursor = to;
    if (!chunk.trim()) return;

    const index = ++this.#sectionCount;
    this.onProgress(`🧩 Summarizing section ${index} (meeting still running)…`);

    this.#sectionQueue.add(async () => {
      try {
        const summary = await summariseSection({ chunk, context: this.#context(), index });
        this.#sections.push(summary);
        this.onProgress(`✅ Section ${index} finished summarizing`);
      } catch (err) {
        // Losing a section would silently drop that slice of the meeting, so
        // record the failure and fall back to a full-transcript pass later.
        this.#sectionFailures += 1;
        console.error(`[notes] section ${index} failed: ${err.message}`);
        this.onProgress(`⚠️ Section ${index} failed — will summarize from the full transcript`);
      }
    });
  }

  /** Speaker-attributed, timestamped transcript. Consecutive lines are merged. */
  buildTranscript() {
    return this.#renderLines(this.utterances);
  }

  #renderLines(utterances) {
    const lines = [];
    for (const u of [...utterances].sort((a, b) => a.startedAt - b.startedAt)) {
      if (!u.text) continue;
      const prev = lines.at(-1);
      if (prev && prev.speaker === u.speaker) {
        prev.text += ' ' + u.text;
        continue;
      }
      lines.push({
        speaker: u.speaker,
        offset: u.startedAt - this.startedAt,
        text: u.text,
      });
    }
    return lines
      .map((l) => `[${formatOffset(l.offset)}] ${l.speaker}: ${l.text}`)
      .join('\n');
  }

  /**
   * Stop listening, finish any in-flight transcription, write the notes file.
   * @returns {Promise<{filePath: string, markdown: string, transcript: string, stats: object}>}
   */
  async stop() {
    this.stopping = true;
    this.detach?.();

    try {
      this.connection?.destroy();
    } catch {
      /* already gone */
    }
    sessions.delete(this.guild.id);

    const stillQueued = this.queue.pending;
    if (stillQueued) {
      this.onProgress(`🎙️ Transcribing the last ${stillQueued} segment(s)…`);
    }
    await this.queue.drain();
    this.onProgress(`✅ Transcription complete — summarizing with ${llmLabel()}`);

    const endedAt = Date.now();
    const durationMs = endedAt - this.startedAt;
    const transcript = this.buildTranscript();
    const participants = [...this.speakers.values()];
    const title = `${this.voiceChannel.name} — ${new Date(this.startedAt).toLocaleDateString()}`;

    let body;
    if (!transcript.trim()) {
      body = emptyNotes(this.format);
    } else {
      // Finish any rolling section work started during the meeting.
      let sections = [];
      if (this.parallelSummaries && this.#sectionCount) {
        this.#cutSection(this.#sectionCursor, this.utterances.length); // trailing slice
        if (this.#sectionQueue.pending) {
          this.onProgress(`🧩 Finishing ${this.#sectionQueue.pending} in-flight section(s)…`);
        }
        await this.#sectionQueue.drain();
        // A failed section would silently drop part of the meeting; summarising
        // from the full transcript instead is slower but complete.
        sections = this.#sectionFailures ? [] : this.#sections;
      }

      if (isCloud()) {
        // Nothing is competing for the GPU, so leave Whisper loaded and ready
        // for the next meeting.
        body = await generateNotes({
          transcript,
          title,
          participants,
          sections,
          format: this.format,
          onProgress: (t) => this.onProgress(t),
        });
      } else {
        // Hand the GPU over: on a 12GB card Whisper and a 9B model together
        // leave under 500MB of headroom. Transcription is already drained.
        this.onProgress('🔀 Freeing GPU memory for the note writer…');
        await unloadStt();
        try {
          body = await generateNotes({
            transcript,
            title,
            participants,
            format: this.format,
            onProgress: (t) => this.onProgress(t),
          });
        } finally {
          await releaseLlm();
        }
      }
    }

    const markdown = this.#assemble({
      body,
      transcript,
      participants,
      durationMs,
      failed: this.failedCount,
    });

    await ensureDir(config.notesDir);
    const filePath = path.join(config.notesDir, `${this.slug}.md`);
    await fs.writeFile(filePath, markdown, 'utf8');

    if (!config.keepAudio) {
      await fs.rm(this.audioDir, { recursive: true, force: true }).catch(() => {});
    }

    return {
      filePath,
      markdown,
      transcript,
      stats: {
        durationMs,
        participants,
        utterances: this.transcribedCount,
        failed: this.failedCount,
        audioKept: config.keepAudio ? this.audioDir : null,
      },
    };
  }

  #assemble({ body, transcript, participants, durationMs, failed }) {
    const header = [
      ...(this.format === 'minutes'
        ? this.#minutesHeading({ participants, durationMs })
        : this.#standardHeading({ participants, durationMs })),
      '',
      // Never let a broken transcription service masquerade as a quiet meeting.
      ...(failed
        ? [
            `> ⚠️ **${failed} segment(s) could not be transcribed** and are missing from`,
            `> these notes. The transcription service may have stopped mid-meeting —`,
            `> check that it is running (\`npm run stt\`).`,
            '',
          ]
        : []),
      '---',
      '',
    ].join('\n');

    const footer = transcript.trim()
      ? ['', '---', '', '## Full Transcript', '', '```text', transcript, '```', ''].join('\n')
      : '';

    return header + body.trim() + '\n' + footer;
  }

  #standardHeading({ participants, durationMs }) {
    return [
      `# Meeting Notes — ${this.voiceChannel.name}`,
      '',
      `- **Date:** ${new Date(this.startedAt).toLocaleString()}`,
      `- **Duration:** ${formatDuration(durationMs)}`,
      `- **Voice channel:** #${this.voiceChannel.name}`,
      `- **Participants:** ${participants.join(', ') || '_none detected_'}`,
      `- **Requested by:** ${this.requester.username}`,
      `- **Notes by:** ${llmLabel()}`,
    ];
  }

  /**
   * The minutes format opens with the template's title + Overview block. It is
   * built here rather than asked of the model because every field in it is
   * something we know exactly and the model would have to guess at.
   */
  #minutesHeading({ participants, durationMs }) {
    const date = new Date(this.startedAt).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
    return [
      `# ${date} | ${this.voiceChannel.name.toUpperCase()}`,
      '',
      '## Overview',
      '',
      `- **Date:** ${date}`,
      `- **Duration:** ${formatDuration(durationMs)}`,
      `- **Attendees:** ${participants.join(', ') || '_none detected_'}`,
      `- **Location/Link:** Discord voice — #${this.voiceChannel.name}`,
      `- **Requested by:** ${this.requester.username}`,
      `- **Notes by:** ${llmLabel()}`,
    ];
  }
}

/** Leftover connection with no session (e.g. after a crash/restart). */
export function orphanConnection(guildId) {
  return !sessions.has(guildId) && Boolean(getVoiceConnection(guildId));
}
