# 🥣 Oatmeal — local AI meeting notes for Discord

A Discord bot that joins a voice channel, transcribes the conversation, and
delivers markdown meeting notes — by DM to whoever asked it to join (default),
by DM to everyone who spoke, or posted in a channel, configurable per user with `/config`.

**Transcription is always local** — audio never leaves your machine. Note writing
runs on either a cloud LLM (default) or a fully local one:

```
                                            ┌─ cloud (default) ─ OpenRouter · Nemotron 3 Ultra
/join ─▶ voice capture ─▶ faster-whisper ─▶─┤                                                  ─▶ DM
         (per-speaker Opus)  (local, GPU)   └─ local (--local) ── Ollama · qwen3.5:9b            (.md)
```

| | Cloud (default) | Local (`--local`) |
| --- | --- | --- |
| Notes written by | Nemotron 3 Ultra (free tier) | qwen3.5:9b on your GPU |
| Audio leaves machine | **Never** | Never |
| Speaker names leave machine | **Never** (pseudonymised) | Never |
| Sections summarised | **In parallel with transcription** | After the meeting |
| Needs internet | Yes | No |

Even in cloud mode, real names are swapped for `Speaker1`/`Speaker2` before
anything is sent and restored afterwards — see [Pseudonymisation](#pseudonymisation).

---

## How it works

Discord delivers a **separate Opus stream per speaker**, so speaker attribution is
exact — there's no diarisation guesswork. Each contiguous burst of speech becomes
one `.wav`, which is transcribed as soon as it ends. When you run `/leave`, the
attributed transcript goes to a local LLM that writes the notes.

| Stage | What handles it |
| --- | --- |
| Voice capture | `@discordjs/voice` + `@discordjs/opus` |
| Resampling to 16kHz mono | `ffmpeg` |
| Transcription | `faster-whisper` (`large-v3`) over a localhost HTTP sidecar |
| Note writing | Ollama (`qwen3.5:9b` by default) |
| Delivery | Direct message with a `.md` attachment |

---

## Requirements

- **Node.js 20+** and **Python 3.10+**
- **ffmpeg** on your `PATH`
- **[Ollama](https://ollama.com)** running locally
- A GPU is strongly recommended. With ~6GB+ of VRAM you can run `large-v3` in
  float16 comfortably; without a GPU the sidecar falls back to int8 on CPU, which
  works but is slow on long meetings (see [Tuning](#tuning-for-your-hardware)).

---

## Setup

### 1. Install dependencies

```bash
npm install

python -m venv stt/.venv
stt/.venv/Scripts/python -m pip install -r stt/requirements.txt   # Windows
# source stt/.venv/bin/activate && pip install -r stt/requirements.txt   # macOS/Linux

ollama pull qwen3.5:9b
```

### 2. Create the Discord application

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
   and click **New Application**.
2. **Bot** tab → **Reset Token** → copy it. This is `DISCORD_TOKEN`.
3. **General Information** tab → copy the **Application ID**. This is `DISCORD_CLIENT_ID`.
4. **Installation** tab → under *Guild Install*, add scopes `bot` and
   `applications.commands`, and the bot permissions **View Channel**, **Connect**,
   and **Send Messages**.
5. Copy the generated install link, open it, and add the bot to your server.

> No privileged gateway intents are needed — the bot only uses Guilds and Voice States.

### 3. Configure

```bash
cp .env.example .env
```

Fill in `DISCORD_TOKEN` and `DISCORD_CLIENT_ID`. Set `DISCORD_GUILD_ID` to your
server's ID while developing so slash commands appear instantly instead of taking
up to an hour to propagate globally. (Enable Developer Mode in Discord, then
right-click your server → Copy Server ID.)

### 4. Register the slash commands

```bash
npm run register
```

Re-run this only when you change command definitions.

### 5. Run it

Two processes, in two terminals:

```bash
npm run stt          # terminal 1 — loads Whisper, then serves on 127.0.0.1:8756

npm start            # terminal 2 — cloud notes (default)
npm run start:local  #            — or fully offline
```

The backend is chosen by flag, falling back to `LLM_BACKEND` in `.env`, defaulting
to cloud. A flag always wins, so you can override per-launch:

```bash
npm start -- --local    # offline for this run
npm start -- --cloud    # cloud even if LLM_BACKEND=local
```

Cloud mode needs `OPENROUTER_API_KEY`; the bot refuses to start without it rather
than failing after a meeting has been recorded.

The first `npm run stt` downloads the model (~3GB for `large-v3`); later starts
take a few seconds. Wait for `model ready` before starting a meeting.

---

## Usage

| Command | What it does |
| --- | --- |
| `/join` | Joins your current voice channel and starts taking notes. Optionally `/join channel:#some-vc delivery:<mode> delivery-channel:#some-channel`. Replies privately to you; the room only sees a short "started taking notes" line. |
| `/leave` | Stops, writes the notes, and delivers them per the active delivery mode. Replies privately to you. |
| `/status` | Shows the active session plus whether Whisper and Ollama are reachable. |
| `/config` | Sets your default notes delivery for this server: `delivery:<mode>` (and `delivery-channel:` if the mode is "Post in a channel"). |

**Delivery modes** (`me` / `everyone` / `channel`, picked via `/config` and
overridable per-meeting with `/join delivery:`):
- **DM me only** (default) — notes go by DM to whoever ran `/join`.
- **DM everyone who spoke** — notes go by DM to every participant who was heard talking.
- **Post in a channel** — notes are posted (with the file attached) in the channel you set with `delivery-channel:`.

Defaults are saved per user, per server, in `data/user-config.json`.

Notes are also saved to `notes/` locally. The bot wraps up on its own if everyone
leaves the call or the voice connection drops, so a crashed meeting still produces
notes.

**If a DM doesn't arrive:** Discord silently blocks DMs from bots when
*Settings → Privacy & Safety → Direct Messages* is off for that server. When
that happens the notes are posted/attached instead of silently disappearing.

### What the notes look like

```markdown
# Meeting Notes — standup

- **Date:** 30/07/2026, 10:02:11
- **Duration:** 12m 40s
- **Participants:** Priya, Marcus, Dana
- **Requested by:** priya

## Summary
The team agreed to move the launch to March 14th...

## Decisions
- Launch date moved to March 14th to absorb the migration slip.

## Action Items
- [ ] **Priya** — finish the migration script by Friday
- [ ] **Unassigned** — decide whether the legacy endpoint stays alive

## Open Questions
- Whether the legacy endpoint can be retired without breaking partner integrations.

---

## Full Transcript
[00:00:03] Priya: Okay team, let's lock the launch date for March fourteenth...
```

---

## Progress reporting

Once you run `/leave` — and during the meeting in cloud mode — the bot keeps a
single live status message in the channel:

```
🧩 Summarizing section 1 (meeting still running)…
✅ Section 1 finished summarizing
🧩 Summarizing section 2 (meeting still running)…
✅ Section 2 finished summarizing
🎙️ Transcribing the last 3 segment(s)…
✅ Transcription complete — summarizing with OpenRouter · nvidia/nemotron-3-ultra-550b-a55b:free
🧩 Consolidating 4 section(s) into final notes…
📄 Notes ready — sending by DM
```

It edits one message rather than posting many, and edits are chained so they can
never land out of order. The same lines go to the console.

## Parallel summarisation (cloud mode)

In local mode Whisper and the LLM contend for the same GPU, so they are strictly
sequenced. In cloud mode the LLM is remote, so there is nothing to contend for —
every ~8,000 characters of transcript (roughly 9 minutes of speech) the bot cuts a
**section** and summarises it *while the meeting is still running*.

By the time you run `/leave`, most of the work is already done and only the
consolidation pass remains. Details that matter:

- Sections are only ever cut from utterances that have **actually been
  transcribed**, never from the not-yet-processed tail.
- Section summaries stay in pseudonym space, so a section summarised in minute 5
  uses the same aliases as the final pass.
- If any section fails, the bot **discards all of them** and summarises from the
  full transcript instead — a partial set would silently drop that slice of the
  meeting.
- The consolidation pass gets the full raw transcript alongside the section
  summaries when it fits (Nemotron's 1M window means it essentially always does),
  so nothing is lost to the condensing.

## Pseudonymisation

Real speaker names are replaced with `Speaker1`, `Speaker2`, … before anything is
sent to the LLM, and restored in the finished notes.

This is **not optional in cloud mode**: NVIDIA's free Nemotron endpoint scrubs PII
from the *input*, so real names arrive at the model as `[PERSON_NAME]` and speaker
attribution — the whole point of this bot — is destroyed. `Speaker1`-style labels
pass through untouched. (`SPK_1` does not, so don't "simplify" the format.)

The same path runs in local mode for consistency, and it means that in cloud mode
your colleagues' names never leave the machine at all.

## VRAM and the model handoff

**Local mode only.** In cloud mode nothing competes for the GPU, so Whisper simply
stays loaded and ready for the next meeting.

In local mode, Whisper and the note-writing LLM are **never resident at the same
time**. Whisper works during the call; the LLM only runs after `/leave`. So Oatmeal
hands the GPU over: it unloads Whisper before writing notes, then releases the LLM
afterwards so the next meeting gets a clean card.

Measured on a 12GB RTX 3060 with `large-v3` + `qwen3.5:9b`:

| | Peak VRAM | Headroom |
| --- | --- | --- |
| Both models resident | 11803 MiB | 485 MiB |
| **With the handoff** | **8172 MiB** | **4116 MiB** |

Without it the combination fits, but only just — opening a hardware-accelerated
browser or a Parsec stream mid-meeting is enough to push Ollama into CPU offload
or OOM Whisper. Reloading Whisper on the next `/join` costs ~4s from disk cache,
and it happens while the bot is connecting, so it's invisible in practice.

If you have 16GB+ of VRAM the handoff is harmless — it just keeps the card tidy.
If you have **8GB or less**, drop to `WHISPER_MODEL=distil-large-v3` (~3GB) or
`medium` (~2.5GB), and consider a smaller `OLLAMA_MODEL`.

## Tuning for your hardware

Set these in `.env` (bot) or as environment variables (STT sidecar).

**Transcription quality vs. speed** — `WHISPER_MODEL`:

| Model | VRAM (fp16) | Notes |
| --- | --- | --- |
| `large-v3` | ~4.7GB | Default. Best accuracy, multilingual. |
| `distil-large-v3` | ~3GB | ~6x faster, English-only, accuracy close to large-v3. |
| `medium` | ~2.5GB | Good middle ground. |
| `small` / `base` | <1.5GB | Fast on CPU; noticeably more errors on crosstalk. |

Other STT options if you want to experiment: **`distil-large-v3`** is the best
speed/accuracy trade for English. **NVIDIA Parakeet TDT 0.6B** (via NeMo) tops the
Open ASR leaderboard and is dramatically faster, but is English-only and a heavier
dependency. **whisper.cpp** is the easiest CPU-only path if you'd rather not
install CUDA libraries.

**Other knobs:**

- `WHISPER_DEVICE` / `WHISPER_COMPUTE` — force `cpu` / `int8` if CUDA misbehaves.
- `WHISPER_LANG` — defaults to `en`. Set `auto` to detect per utterance (slower).
- `OLLAMA_MODEL` — any pulled model. Smaller (`llama3.2:3b`) is faster but produces
  flatter notes; larger produces better structure.
- `SILENCE_MS` (default 800) — how long a pause ends an utterance. Lower is more
  responsive, higher keeps sentences intact.
- `MIN_UTTERANCE_MS` (default 400) — discards coughs and mic bumps.
- `KEEP_AUDIO=true` — keeps the per-utterance `.wav` files in `recordings/`
  instead of deleting them when the meeting ends. Useful for debugging.

---

## Consent

This bot transcribes people. `/join` posts a visible "started taking notes"
message in the channel it was invoked from, but that is the only notice —
participants who join later, or who are in the voice channel without watching
that text channel, get no explicit warning beyond seeing the bot present. (The
detailed confirmation and delivery-mode summary, by contrast, are only visible
to whoever ran the command.)

Recording without telling participants is illegal in two-party-consent
jurisdictions, so telling the room is on you. If you want a louder notice, the
message is a single string in `handleJoin` ([src/index.js](src/index.js)).

---

## Troubleshooting

**`Library cublas64_12.dll is not found`** — the CUDA libs weren't picked up.
`stt/server.py` adds the pip-installed `nvidia-*` DLL directories to the search
path automatically; if it still fails, `pip install -r stt/requirements.txt` again,
or set `WHISPER_DEVICE=cpu WHISPER_COMPUTE=int8` to sidestep the GPU.

**Bot joins but transcribes nothing** — it needs to *not* be server-deafened.
Check the channel's permissions, and confirm `/status` shows the STT service as up.

**Whisper invents "Thank you." / "Subscribe!"** — classic hallucination on
near-silence. The sidecar runs a VAD filter to suppress it; raising
`MIN_UTTERANCE_MS` helps further.

**Slash commands don't appear** — set `DISCORD_GUILD_ID` and re-run `npm run register`.
Global registration can take up to an hour.

**Notes are cut off or vague on long meetings** — the transcript is summarised in
chunks and consolidated, but a small `OLLAMA_MODEL` will struggle. Try a larger model.
