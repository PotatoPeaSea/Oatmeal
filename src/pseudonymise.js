/**
 * Speaker pseudonymisation.
 *
 * Two reasons this exists:
 *
 * 1. Correctness. NVIDIA's free Nemotron endpoint scrubs PII from the *input*
 *    before the model sees it — real names arrive as "[PERSON_NAME]", which
 *    destroys the speaker attribution that is this bot's whole advantage.
 *    "Speaker1"-style labels pass through untouched (verified against the
 *    endpoint; "SPK_1" does not, so don't "simplify" the format).
 *
 * 2. Privacy. In cloud mode the real names never leave this machine at all.
 *
 * The map is session-scoped and append-only: someone who speaks for the first
 * time an hour in still gets a stable alias, so section summaries produced
 * early in the meeting stay consistent with the final pass.
 */

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function createSpeakerMap() {
  const toAlias = new Map(); // real name -> Speaker3
  const fromAlias = new Map(); // Speaker3 -> real name

  function alias(name) {
    const existing = toAlias.get(name);
    if (existing) return existing;
    const next = `Speaker${toAlias.size + 1}`;
    toAlias.set(name, next);
    fromAlias.set(next, name);
    return next;
  }

  return {
    alias,

    get size() {
      return toAlias.size;
    },

    /** Alias list in order, for prompts that need a participant roster. */
    aliases() {
      return [...fromAlias.keys()];
    },

    /**
     * Replace every known speaker name with its alias — both the "Name:"
     * attribution labels and any mention inside the speech itself, since
     * "Dana will check" would otherwise be redacted mid-sentence.
     */
    encode(text) {
      let out = text;
      // Longest first, so "Dana Smith" is handled before "Dana".
      for (const name of [...toAlias.keys()].sort((a, b) => b.length - a.length)) {
        const re = new RegExp(`\\b${escapeRegex(name)}\\b`, 'gi');
        out = out.replace(re, toAlias.get(name));
      }
      return out;
    },

    /** Put the real names back. Tolerates "Speaker 3" as well as "Speaker3". */
    decode(text) {
      return text.replace(/\bSpeaker\s*(\d+)\b/gi, (match, n) => fromAlias.get(`Speaker${n}`) ?? match);
    },
  };
}
