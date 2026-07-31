import { llmChat, llmLabel, singlePassLimit, chunkChars } from './llm.js';
import { isCloud } from './config.js';
import { createSpeakerMap } from './pseudonymise.js';

/**
 * How much transcript accumulates before cloud mode cuts a section and starts
 * summarising it *while the meeting is still running*. Speech is roughly 900
 * chars/minute, so this is a section every ~9 minutes.
 */
export const SECTION_CHARS = 8_000;

const NOTE_SECTIONS = `## Summary
A short paragraph on what the meeting was about and what came out of it.

## Key Discussion Points
Bullets grouped by topic. Attribute meaningful positions to the person who took them.

## Decisions
Bullets of what was actually decided. If nothing was decided, write "_None recorded._"

## Action Items
Checklist items in the form "- [ ] **Owner** — the task (due date if one was given)".
Capture EVERY commitment anyone made, including ones people volunteered for
themselves ("I'll finish X by Friday" is an action item for that speaker).
Use "**Unassigned**" when no owner was named. If there are none, write "_None recorded._"

## Open Questions
Anything left unresolved. If there are none, write "_None recorded._"`;

const RULES = `Rules:
- Output GitHub-flavoured Markdown only. No preamble, no sign-off, no code fences around the whole document.
- Start directly with "## Summary".
- Use only what is in the transcript. Never invent decisions, owners, dates, or numbers.
- The transcript is machine-generated and may contain mishearings. If something is
  garbled, summarise the intent rather than quoting it, and don't guess at names.
- Refer to speakers by the names given in the transcript.
- Be concise. Prefer specifics over restating that a topic "was discussed".`;

const SECTION_SYSTEM =
  'You condense meeting transcripts faithfully. Preserve who said what, every ' +
  'decision, every action item with its owner, and every open question. Use only ' +
  'what is in the transcript. Output plain Markdown bullets.';

/** Split on line boundaries so an utterance is never cut in half. */
function chunkTranscript(transcript, size) {
  const chunks = [];
  let current = '';
  for (const line of transcript.split('\n')) {
    if (current.length + line.length + 1 > size && current) {
      chunks.push(current);
      current = '';
    }
    current += line + '\n';
  }
  if (current.trim()) chunks.push(current);
  return chunks;
}

/**
 * Condense one slice of a meeting into dense bullets.
 * In cloud mode this runs during the meeting, overlapped with transcription.
 *
 * The result stays in *alias* space (Speaker1, Speaker2...). Only the final
 * document is decoded, so sections summarised early in a meeting remain
 * consistent with the consolidation pass at the end.
 */
export async function summariseSection({ chunk, context, index, total, speakers }) {
  const map = speakers ?? createSpeakerMap();
  return llmChat(
    [
      { role: 'system', content: SECTION_SYSTEM },
      {
        role: 'user',
        content:
          `${map.encode(context)}\n\nThis is part ${index}${total ? ` of ${total}` : ''} of the ` +
          `transcript. Condense it into detailed bullets.\n\n"""\n${map.encode(chunk)}\n"""`,
      },
    ],
    { temperature: 0.2 }
  );
}

/**
 * Turn a speaker-attributed transcript into the body of a meeting-notes doc.
 *
 * @param {string[]} sections  Pre-computed section summaries. Cloud mode fills
 *   these in during the meeting; passing them lets the final pass skip the map
 *   step entirely. The raw transcript is still supplied alongside them when it
 *   fits in context, so nothing is lost to the condensing.
 * @param {(text: string) => void} onProgress  Called with human-readable status.
 */
export async function generateNotes({
  transcript,
  title,
  participants,
  sections = [],
  speakers,
  onProgress = () => {},
}) {
  // Names are swapped for Speaker1/Speaker2 before anything is sent, and put
  // back at the very end. See pseudonymise.js for why this is not optional.
  const map = speakers ?? createSpeakerMap();
  for (const p of participants) map.alias(p);

  const rawContext = `Meeting: ${title}\nParticipants: ${map.aliases().join(', ') || 'unknown'}`;
  const context = map.encode(rawContext);
  transcript = map.encode(transcript);
  const fitsWhole = transcript.length <= singlePassLimit();

  const notesSystem = { role: 'system', content: `You write clear, accurate meeting notes.\n\n${RULES}` };

  const consolidate = (partials, includeTranscript) =>
    llmChat([
      notesSystem,
      {
        role: 'user',
        content:
          `${context}\n\nBelow are ordered notes from consecutive parts of one meeting. ` +
          `Merge them into a single set of notes using exactly these sections, ` +
          `de-duplicating anything repeated across parts:\n\n${NOTE_SECTIONS}\n\n` +
          partials.map((p, i) => `--- Part ${i + 1} ---\n${p}`).join('\n\n') +
          // Nemotron's 1M window means the source material fits alongside the
          // condensed parts, so the final pass isn't limited to what the
          // condensing happened to preserve.
          (includeTranscript
            ? `\n\n--- Full transcript, to resolve anything ambiguous above ---\n"""\n${transcript}\n"""`
            : ''),
      },
    ]);

  // --- sections were already summarised during the meeting (cloud mode) ---
  if (sections.length) {
    onProgress(`🧩 Consolidating ${sections.length} section(s) into final notes…`);
    return map.decode(await consolidate(sections, fitsWhole));
  }

  // --- short enough for one pass ---
  if (fitsWhole) {
    onProgress(`🧠 Summarizing with ${llmLabel()}…`);
    return map.decode(
      await llmChat([
        notesSystem,
        {
          role: 'user',
          content:
            `${context}\n\nWrite meeting notes using exactly these sections:\n\n${NOTE_SECTIONS}\n\n` +
            `Transcript:\n"""\n${transcript}\n"""`,
        },
      ])
    );
  }

  // --- too long: map then reduce (local mode, or a genuinely enormous meeting) ---
  const chunks = chunkTranscript(transcript, chunkChars());
  const partials = [];
  for (const [i, chunk] of chunks.entries()) {
    onProgress(`🧩 Summarizing section ${i + 1}/${chunks.length}…`);
    partials.push(
      await summariseSection({ chunk, context, index: i + 1, total: chunks.length, speakers: map })
    );
    onProgress(`✅ Section ${i + 1}/${chunks.length} finished summarizing`);
  }

  onProgress(`🧩 Consolidating ${chunks.length} sections into final notes…`);
  return map.decode(await consolidate(partials, false));
}

/** Cloud mode overlaps summarisation with transcription; local mode cannot. */
export const supportsParallelSummarisation = () => isCloud();
