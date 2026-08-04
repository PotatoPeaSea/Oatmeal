import { llmChat, llmLabel, singlePassLimit, chunkChars } from './llm.js';
import { isCloud } from './config.js';

/**
 * How much transcript accumulates before cloud mode cuts a section and starts
 * summarising it *while the meeting is still running*. Speech is roughly 900
 * chars/minute, so this is a section every ~9 minutes.
 */
export const SECTION_CHARS = 8_000;

const ACTION_ITEM_RULE = `Capture EVERY commitment anyone made, including ones people volunteered for
themselves ("I'll finish X by Friday" is an action item for that speaker).`;

/**
 * The shape of the finished notes, chosen per user with `/config format:` and
 * overridable per meeting with `/join format:`.
 *
 * `sections` is handed to the model verbatim, so it doubles as the spec and the
 * documentation of each format. `first` is the heading the body must open with;
 * `empty` stands in for the body when no speech was captured at all.
 *
 * `minutes` is the odd one out: its Overview block is filled in from real
 * session data by Session#assemble rather than being left to the model, which
 * cannot know the duration or who was silent. Its body therefore starts at the
 * agenda.
 */
const FORMATS = {
  standard: {
    label: 'Standard',
    description: 'Summary, discussion points, decisions, action items, open questions',
    first: '## Summary',
    empty: '## Summary\n\n_No speech was captured during this meeting, so there is nothing to summarise._\n',
    sections: `## Summary
A short paragraph on what the meeting was about and what came out of it.

## Key Discussion Points
Bullets grouped by topic. Attribute meaningful positions to the person who took them.

## Decisions
Bullets of what was actually decided. If nothing was decided, write "_None recorded._"

## Action Items
Checklist items in the form "- [ ] **Owner** — the task (due date if one was given)".
${ACTION_ITEM_RULE}
Use "**Unassigned**" when no owner was named. If there are none, write "_None recorded._"

## Open Questions
Anything left unresolved. If there are none, write "_None recorded._"`,
  },

  simplified: {
    label: 'Simplified',
    description: 'A short summary, a handful of highlights, and the action items',
    first: '## Summary',
    empty: '## Summary\n\n_No speech was captured during this meeting, so there is nothing to summarise._\n',
    rules: [
      'Keep the whole document under roughly 250 words. Drop detail rather than adding sections.',
    ],
    sections: `## Summary
Three or four sentences on what the meeting was about, what was decided, and what happens next.

## Highlights
At most six bullets, one line each, covering only what someone who missed the
meeting would need to know. Fold decisions in here rather than listing them separately.

## Action Items
Checklist items in the form "- [ ] **Owner** — the task (due date if one was given)".
${ACTION_ITEM_RULE}
Use "**Unassigned**" when no owner was named. If there are none, write "_None recorded._"`,
  },

  minutes: {
    label: 'Meeting minutes',
    description: 'Agenda, discussion notes, an action-item table, references, learnings',
    first: '## Agenda',
    empty: '## Discussion Notes\n\n_No speech was captured during this meeting, so there is nothing to summarise._\n',
    rules: [
      'Do not write a title or an Overview section — both are added above your output already.',
    ],
    sections: `## Agenda
The topics the meeting set out to cover, as "- **[Topic]**" bullets with the
specifics raised under each as indented sub-bullets. Only list topics that were
actually raised.

## Discussion Notes
What was actually said, grouped under the same topics as the agenda. Attribute
meaningful positions to the person who took them.

## Action Items
A Markdown table with exactly this header:

| Owner | Task Description | Due Date/ETA |
| :---- | :---- | :---- |

One row per commitment. ${ACTION_ITEM_RULE}
Use "Unassigned" as the owner when no one was named, and "TBD" as the due date
when none was given. If there are no action items, write "_None recorded._"
instead of the table.

## Reference & Resources
Links, documents, trackers, or tools referred to during the meeting, as bullets.
If none were mentioned, write "_None mentioned._"

## Learnings & Best Practices
Anything the group concluded is worth carrying forward. If there is nothing,
write "_None recorded._"`,
  },
};

export const DEFAULT_FORMAT = 'standard';

/** Choice list for the slash commands. */
export const NOTE_FORMATS = Object.entries(FORMATS).map(([value, f]) => ({
  value,
  label: f.label,
  description: f.description,
}));

export const isNoteFormat = (value) => Object.hasOwn(FORMATS, value);

const resolveFormat = (value) => FORMATS[value] ?? FORMATS[DEFAULT_FORMAT];

export const formatLabel = (value) => resolveFormat(value).label;

/** Body used when a meeting produced no transcript at all. */
export const emptyNotes = (value) => resolveFormat(value).empty;

const rulesFor = (fmt) =>
  [
    'Rules:',
    '- Output GitHub-flavoured Markdown only. No preamble, no sign-off, no code fences around the whole document.',
    `- Start directly with "${fmt.first}".`,
    '- Use only what is in the transcript. Never invent decisions, owners, dates, or numbers.',
    '- The transcript is machine-generated and may contain mishearings. If something is',
    "  garbled, summarise the intent rather than quoting it, and don't guess at names.",
    '- Refer to speakers by the names given in the transcript.',
    '- Be concise. Prefer specifics over restating that a topic "was discussed".',
    ...(fmt.rules ?? []).map((r) => `- ${r}`),
  ].join('\n');

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
 */
export async function summariseSection({ chunk, context, index, total }) {
  return llmChat(
    [
      { role: 'system', content: SECTION_SYSTEM },
      {
        role: 'user',
        content:
          `${context}\n\nThis is part ${index}${total ? ` of ${total}` : ''} of the ` +
          `transcript. Condense it into detailed bullets.\n\n"""\n${chunk}\n"""`,
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
 * @param {string} format  Which of FORMATS to write. Only the final document is
 *   shaped by it, so section summaries stay reusable whatever the format is.
 * @param {(text: string) => void} onProgress  Called with human-readable status.
 */
export async function generateNotes({
  transcript,
  title,
  participants,
  sections = [],
  format = DEFAULT_FORMAT,
  onProgress = () => {},
}) {
  const context = `Meeting: ${title}\nParticipants: ${participants.join(', ') || 'unknown'}`;
  const fitsWhole = transcript.length <= singlePassLimit();

  const fmt = resolveFormat(format);
  const notesSystem = {
    role: 'system',
    content: `You write clear, accurate meeting notes.\n\n${rulesFor(fmt)}`,
  };

  const consolidate = (partials, includeTranscript) =>
    llmChat([
      notesSystem,
      {
        role: 'user',
        content:
          `${context}\n\nBelow are ordered notes from consecutive parts of one meeting. ` +
          `Merge them into a single set of notes using exactly these sections, ` +
          `de-duplicating anything repeated across parts:\n\n${fmt.sections}\n\n` +
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
    return consolidate(sections, fitsWhole);
  }

  // --- short enough for one pass ---
  if (fitsWhole) {
    onProgress(`🧠 Summarizing with ${llmLabel()}…`);
    return llmChat([
      notesSystem,
      {
        role: 'user',
        content:
          `${context}\n\nWrite meeting notes using exactly these sections:\n\n${fmt.sections}\n\n` +
          `Transcript:\n"""\n${transcript}\n"""`,
      },
    ]);
  }

  // --- too long: map then reduce (local mode, or a genuinely enormous meeting) ---
  const chunks = chunkTranscript(transcript, chunkChars());
  const partials = [];
  for (const [i, chunk] of chunks.entries()) {
    onProgress(`🧩 Summarizing section ${i + 1}/${chunks.length}…`);
    partials.push(await summariseSection({ chunk, context, index: i + 1, total: chunks.length }));
    onProgress(`✅ Section ${i + 1}/${chunks.length} finished summarizing`);
  }

  onProgress(`🧩 Consolidating ${chunks.length} sections into final notes…`);
  return consolidate(partials, false);
}

/** Cloud mode overlaps summarisation with transcription; local mode cannot. */
export const supportsParallelSummarisation = () => isCloud();
