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
import { formatLabel } from './notes.js';
import { getUserPrefs, setUserPrefs } from './userConfig.js';

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
    else if (interaction.commandName === 'config') await handleConfig(interaction);
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

  const {
    mode: deliveryMode,
    channelId: deliveryChannelId,
    format,
  } = await resolvePrefs(interaction);

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const session = new Session({
    guild,
    voiceChannel: channel,
    textChannel: interaction.channel,
    requester: interaction.user,
    deliveryMode,
    deliveryChannelId,
    format,
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

  // The command reply below is ephemeral (visible only to whoever ran /join),
  // so this public line is the room's only notice that recording has started.
  await interaction.channel
    .send(`🔴 **${interaction.user} started taking notes in ${channel}.**`)
    .catch(() => {});

  await interaction.editReply(
    `🔴 **Now taking notes in ${channel}.** Run \`/leave\` when you're done. ` +
      `Notes delivery: ${describeDelivery(deliveryMode, deliveryChannelId)}. ` +
      `Format: **${formatLabel(format)}**.`
  );
}

/**
 * Work out how notes should be delivered and written for this session: an
 * explicit `/join delivery:` / `/join format:` flag wins, otherwise fall back to
 * the caller's saved `/config` defaults (and finally "DM me", "Standard").
 */
async function resolvePrefs(interaction) {
  const modeOpt = interaction.options.getString('delivery');
  const channelOpt = interaction.options.getChannel('delivery-channel');
  const formatOpt = interaction.options.getString('format');

  const saved = await getUserPrefs(interaction.guild.id, interaction.user.id);
  const format = formatOpt ?? saved.format;

  if (modeOpt) {
    return {
      mode: modeOpt,
      channelId: modeOpt === 'channel' ? channelOpt?.id ?? interaction.channel.id : null,
      format,
    };
  }

  // A saved "post in a channel" default with no channel means the channel was
  // deleted, or the default predates the option; fall back to the current one.
  const channelId =
    saved.mode === 'channel' ? saved.channelId ?? interaction.channel.id : saved.channelId;
  return { mode: saved.mode, channelId, format };
}

function describeDelivery(mode, channelId) {
  if (mode === 'everyone') return "DM'd to everyone who spoke";
  if (mode === 'channel') return `posted in <#${channelId}>`;
  return 'DM to you';
}

async function handleLeave(interaction) {
  const session = getSession(interaction.guild.id);
  if (!session) {
    return interaction.reply({
      content: "I'm not taking notes right now. Start a session with `/join`.",
      flags: MessageFlags.Ephemeral,
    });
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await interaction.editReply(
    `📝 Wrapping up — follow along above. Writing notes with ${llmLabel()}.`
  );

  const result = await finalise(session, interaction.channel, null);

  const summary =
    `✅ **Notes ready.** ${describe(result.stats)}\n` +
    (result.delivered ? result.deliverySummary : `${result.deliverySummary} Here they are:`);

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

async function handleConfig(interaction) {
  const mode = interaction.options.getString('delivery');
  const channel = interaction.options.getChannel('delivery-channel');
  const format = interaction.options.getString('format');

  // Both options are optional so either can be changed alone; with neither,
  // show what is currently saved rather than silently doing nothing.
  if (!mode && !format) {
    const saved = await getUserPrefs(interaction.guild.id, interaction.user.id);
    return interaction.reply({
      content:
        `Your current defaults — delivery: ${describeDelivery(saved.mode, saved.channelId)}, ` +
        `format: **${formatLabel(saved.format)}**.\n` +
        'Change them with `/config delivery:` and/or `/config format:`.',
      flags: MessageFlags.Ephemeral,
    });
  }

  if (mode === 'channel' && !channel) {
    return interaction.reply({
      content:
        'Pick a channel with `delivery-channel:#some-channel` when delivery is "Post in a channel".',
      flags: MessageFlags.Ephemeral,
    });
  }

  const patch = {};
  if (mode) Object.assign(patch, { mode, channelId: mode === 'channel' ? channel.id : null });
  if (format) patch.format = format;

  const saved = await setUserPrefs(interaction.guild.id, interaction.user.id, patch);

  const changed = [
    ...(mode ? [`delivery: ${describeDelivery(saved.mode, saved.channelId)}`] : []),
    ...(format ? [`format: **${formatLabel(saved.format)}**`] : []),
  ];

  await interaction.reply({
    content: `✅ Defaults updated — ${changed.join(', ')}.`,
    flags: MessageFlags.Ephemeral,
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
        `• Format: ${formatLabel(session.format)} — ${describeDelivery(session.deliveryMode, session.deliveryChannelId)}\n` +
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
 * Stop the session, write the notes, and deliver them per the session's
 * configured mode (DM the requester, DM everyone who spoke, or post in a
 * channel). `reason` is set when we're finalising because something went wrong.
 */
async function finalise(session, fallbackChannel, reason) {
  const { filePath, stats } = await session.stop();
  const filename = `${session.slug}.md`;
  const attachment = () => new AttachmentBuilder(filePath, { name: filename });
  const prefix = reason ? `⚠️ ${reason}, so I wrapped up early.\n\n` : '';
  const header = `📄 **Notes from ${session.voiceChannel.name}** — ${describe(stats)}`;

  let delivered = false;
  let deliverySummary = '';

  if (session.deliveryMode === 'channel') {
    session.onProgress(`📄 Notes ready — posting in <#${session.deliveryChannelId}>`);
    const target =
      (session.deliveryChannelId &&
        (await session.guild.channels.fetch(session.deliveryChannelId).catch(() => null))) ||
      fallbackChannel;
    try {
      await target.send({ content: `${prefix}${header}`, files: [attachment()] });
      delivered = true;
      deliverySummary = `Posted in ${target}.`;
    } catch {
      console.warn(`[bot] could not post notes in configured channel for guild ${session.guild.id}`);
      deliverySummary = "I couldn't post in the configured channel, so here they are:";
    }
  } else if (session.deliveryMode === 'everyone') {
    session.onProgress('📄 Notes ready — sending by DM to everyone who spoke');
    const recipients = [...session.speakers.keys()];
    let sent = 0;
    for (const userId of recipients) {
      try {
        const member = await session.guild.members.fetch(userId);
        await member.send({ content: `${prefix}${header}`, files: [attachment()] });
        sent += 1;
      } catch {
        console.warn(`[bot] could not DM participant ${userId}; DMs are probably closed`);
      }
    }
    delivered = sent > 0;
    deliverySummary = recipients.length
      ? `DM'd ${sent}/${recipients.length} participant(s).`
      : "No participants were detected, so I couldn't DM anyone. Here they are:";
  } else {
    session.onProgress('📄 Notes ready — sending by DM');
    try {
      await session.requester.send({ content: `${prefix}${header}`, files: [attachment()] });
      delivered = true;
      deliverySummary = `Sent to ${session.requester} by DM.`;
    } catch {
      console.warn(`[bot] could not DM ${session.requester.tag}; DMs are probably closed`);
      deliverySummary = `I couldn't DM ${session.requester} (their DMs are closed), so here they are:`;
    }
  }

  if (!delivered && reason && fallbackChannel) {
    await fallbackChannel
      .send({
        content: `⚠️ ${reason}. ${session.requester}, I couldn't deliver the notes as configured — attached.`,
        files: [attachment()],
      })
      .catch(() => {});
  }

  return { filePath, stats, delivered, deliverySummary, attachment };
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
