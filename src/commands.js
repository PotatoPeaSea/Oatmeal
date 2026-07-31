import { SlashCommandBuilder, ChannelType } from 'discord.js';

// Stage channels are deliberately excluded: the bot would join as audience and
// receive no audio, which looks like a silent failure.

const DELIVERY_CHOICES = [
  { name: 'DM me only', value: 'me' },
  { name: 'DM everyone who spoke', value: 'everyone' },
  { name: 'Post in a channel', value: 'channel' },
];

export const commands = [
  new SlashCommandBuilder()
    .setName('join')
    .setDescription('Join a voice channel and start taking meeting notes')
    .addChannelOption((opt) =>
      opt
        .setName('channel')
        .setDescription('Which voice channel to join (defaults to the one you are in)')
        .addChannelTypes(ChannelType.GuildVoice)
        .setRequired(false)
    )
    .addStringOption((opt) =>
      opt
        .setName('delivery')
        .setDescription('Who gets the notes for this meeting (overrides your /config default)')
        .setRequired(false)
        .addChoices(...DELIVERY_CHOICES)
    )
    .addChannelOption((opt) =>
      opt
        .setName('delivery-channel')
        .setDescription('Channel to post notes in, used when delivery is "Post in a channel"')
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName('leave')
    .setDescription('Stop recording, write up the notes, and deliver them as configured'),

  new SlashCommandBuilder()
    .setName('status')
    .setDescription('Show the current note-taking session and whether the local models are up'),

  new SlashCommandBuilder()
    .setName('config')
    .setDescription('Set your default meeting-notes delivery for this server')
    .addStringOption((opt) =>
      opt
        .setName('delivery')
        .setDescription('Who should get the notes by default')
        .setRequired(true)
        .addChoices(...DELIVERY_CHOICES)
    )
    .addChannelOption((opt) =>
      opt
        .setName('delivery-channel')
        .setDescription('Channel to post notes in, required when delivery is "Post in a channel"')
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(false)
    ),
].map((c) => c.toJSON());
