import {
  Client,
  GatewayIntentBits,
  AttachmentBuilder,
  PermissionsBitField,
  MessageFlags,
} from 'discord.js';
import { config, assertConfig, isCloud } from './config.js';
import { Session, getSession } from './session.js';
import { sttHealth, warmStt } from './transcribe.js';
import { llmHealth, llmLabel } from './llm.js';
import { formatDuration } from './utils.js';

assertConfig();

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

client.once('clientReady', async (c) => {
  console.log(`[bot] logged in as ${c.user.tag}`);
  console.log(
    `[bot] notes backend: ${config.llmBackend.toUpperCase()} — ${llmLabel()}` +
      (isCloud() ? '  (use --local to stay offline)' : '')
  );

  const [stt, llm] = await Promise.all([sttHealth(), llmHealth()]);
  if (stt) console.log(`[bot] stt ok — ${stt.model} on ${stt.device} (${stt.compute_type})`);
  else console.warn(`[bot] STT sidecar unreachable at ${config.sttUrl}. Run: npm run stt`);

  if (llm.ok) console.log(`[bot] llm ok — ${llm.detail}`);
  else console.warn(`[bot] llm unavailable — ${llm.detail}`);

  console.log('[bot] ready. Use /join in a server to start taking notes.');
});

/**
 * Streams status into a single message in the meeting's text channel, so the
 * room can see what the bot is doing without a wall of separate messages.
 * Edits are chained so they can never land out of order.
 */
function attachProgress(session) {
  const lines = [];
  let message = null;
  let chain = Promise.resolve();

  session.onProgress = (text) => {
    console.log(`[progress] ${text}`);
    lines.push(text);
    const body = lines.slice(-8).join('\n');
    chain = chain.then(async () => {
      try {
        if (message) await message.edit(body);
        else message = await session.textChannel.send(body);
      } catch {
        // Channel deleted or perms revoked mid-meeting; progress is cosmetic.
      }
    });
  };
}

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  try {
    if (interaction.commandName === 'join') await handleJoin(interaction);
    else if (interaction.commandName === 'leave') await handleLeave(interaction);
    else if (interaction.commandName === 'status') await handleStatus(interaction);
  } catch (err) {
    console.error(`[bot] /${interaction.commandName} failed:`, err);
    const msg = `Something went wrong: ${err.message}`;
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content: msg, flags: MessageFlags.Ephemeral }).catch(() => {});
    } else {
      await interaction.reply({ content: msg, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  }
});

async function handleJoin(interaction) {
  const { guild, member } = interaction;

  if (getSession(guild.id)) {
    return interaction.reply({
      content: 'I am already taking notes in this server. Use `/leave` to wrap that session up first.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const channel = interaction.options.getChannel('channel') ?? member.voice?.channel;
  if (!channel) {
    return interaction.reply({
      content: 'Join a voice channel first, or pass one with `/join channel:#your-channel`.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const perms = channel.permissionsFor(guild.members.me);
  const needed = [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.Connect];
  if (!perms?.has(needed)) {
    return interaction.reply({
      content: `I need **View Channel** and **Connect** permissions on ${channel} to sit in on that meeting.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  const [stt, llm] = await Promise.all([sttHealth(), llmHealth()]);
  if (!stt) {
    return interaction.reply({
      content:
        `My transcription service isn't running, so I'd hear nothing. ` +
        `Start it with \`npm run stt\` and try again.`,
      flags: MessageFlags.Ephemeral,
    });
  }
  if (!llm.ok) {
    // Better to refuse now than to record a whole meeting and fail at the end.
    return interaction.reply({
      content: `I can transcribe, but the note writer (${llmLabel()}) is unavailable: ${llm.detail}`,
      flags: MessageFlags.Ephemeral,
    });
  }

  await interaction.deferReply();

  const session = new Session({
    guild,
    voiceChannel: channel,
    textChannel: interaction.channel,
    requester: interaction.user,
  });
  attachProgress(session);

  // If the voice connection dies on its own, still deliver what we captured.
  session.onUnexpectedEnd = () => {
    finalise(session, interaction.channel, 'The voice connection dropped').catch((err) =>
      console.error('[bot] auto-finalise failed:', err)
    );
  };

  // Whisper is unloaded between meetings to keep the GPU free for the note
  // writer, so reload it while we're connecting. Worst case it loads lazily on
  // the first utterance instead — slower, but nothing is dropped.
  await Promise.all([session.start(), warmStt()]);

  await interaction.editReply(
    `🔴 **Now taking notes in ${channel}.** Run \`/leave\` when you're done.`
  );
}

async function handleLeave(interaction) {
  const session = getSession(interaction.guild.id);
  if (!session) {
    return interaction.reply({
      content: "I'm not taking notes right now. Start a session with `/join`.",
      flags: MessageFlags.Ephemeral,
    });
  }

  await interaction.deferReply();
  await interaction.editReply(
    `📝 Wrapping up — follow along above. Writing notes with ${llmLabel()}.`
  );

  const result = await finalise(session, interaction.channel, null);

  const summary =
    `✅ **Notes ready.** ${describe(result.stats)}\n` +
    (result.delivered
      ? `Sent to ${session.requester} by DM.`
      : `I couldn't DM ${session.requester} (their DMs are closed), so here they are:`);

  await interaction
    .editReply({ content: summary, files: result.delivered ? [] : [result.attachment()] })
    .catch(async () => {
      // Interaction token expired on a very long meeting; fall back to a plain message.
      await interaction.channel.send({
        content: summary,
        files: result.delivered ? [] : [result.attachment()],
      });
    });
}

async function handleStatus(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const session = getSession(interaction.guild.id);
  const [stt, llm] = await Promise.all([sttHealth(), llmHealth()]);

  const lines = [
    session
      ? `🔴 **Recording** in ${session.voiceChannel} for ${formatDuration(Date.now() - session.startedAt)}\n` +
        `• Started by ${session.requester}\n` +
        `• ${session.transcribedCount} utterance(s) transcribed, ${session.queue.pending} in the queue\n` +
        `• Speakers so far: ${[...session.speakers.values()].join(', ') || 'none yet'}` +
        (session.parallelSummaries
          ? `\n• Rolling summaries: ${session.sectionsDone}/${session.sectionsStarted} section(s) done`
          : '')
      : '⚪ **Idle** — no session in this server.',
    '',
    stt
      ? `✅ Transcription: \`${stt.model}\` on **${stt.device}** (${stt.compute_type})` +
        (stt.loaded ? '' : ' — _unloaded, will reload on `/join`_')
      : `❌ Transcription sidecar unreachable at ${config.sttUrl} — run \`npm run stt\``,
    llm.ok
      ? `✅ Note writer (**${config.llmBackend}**): \`${
          isCloud() ? config.openrouterModel : config.ollamaModel
        }\` — ${llm.detail}`
      : `❌ Note writer (**${config.llmBackend}**) unavailable — ${llm.detail}`,
    isCloud()
      ? '_Cloud mode: sections are summarized in parallel with transcription._'
      : '_Local mode: fully offline; Whisper and the LLM take turns on the GPU._',
  ];

  await interaction.editReply(lines.join('\n'));
}

/**
 * Stop the session, write the notes, and DM them to whoever started it.
 * `reason` is set when we're finalising because something went wrong.
 */
async function finalise(session, fallbackChannel, reason) {
  const { filePath, stats } = await session.stop();
  session.onProgress('📄 Notes ready — sending by DM');
  const filename = `${session.slug}.md`;
  const attachment = () => new AttachmentBuilder(filePath, { name: filename });

  let delivered = false;
  try {
    await session.requester.send({
      content:
        (reason ? `⚠️ ${reason}, so I wrapped up early.\n\n` : '') +
        `📄 **Notes from ${session.voiceChannel.name}** — ${describe(stats)}`,
      files: [attachment()],
    });
    delivered = true;
  } catch {
    console.warn(`[bot] could not DM ${session.requester.tag}; DMs are probably closed`);
  }

  if (!delivered && reason && fallbackChannel) {
    await fallbackChannel
      .send({
        content: `⚠️ ${reason}. ${session.requester}, I couldn't DM you — notes attached.`,
        files: [attachment()],
      })
      .catch(() => {});
  }

  return { filePath, stats, delivered, attachment };
}

const describe = (stats) =>
  `${formatDuration(stats.durationMs)}, ${stats.participants.length} speaker(s), ` +
  `${stats.utterances} transcribed segment(s).` +
  (stats.failed ? ` ⚠️ ${stats.failed} segment(s) failed to transcribe.` : '');

// Nobody left in the call but us? Wrap up rather than recording an empty room.
client.on('voiceStateUpdate', async (oldState) => {
  const session = getSession(oldState.guild?.id);
  if (!session || session.stopping) return;
  if (oldState.channelId !== session.voiceChannel.id) return;

  const remaining = session.voiceChannel.members.filter((m) => !m.user.bot).size;
  if (remaining > 0) return;

  console.log('[bot] everyone left; finalising');
  await finalise(session, session.textChannel, 'Everyone left the call').catch((err) =>
    console.error('[bot] auto-finalise failed:', err)
  );
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    console.log('\n[bot] shutting down…');
    client.destroy();
    process.exit(0);
  });
}

client.login(config.token);
