import { SlashCommandBuilder, ChannelType } from 'discord.js';
import { NOTE_FORMATS } from './notes.js';

// Stage channels are deliberately excluded: the bot would join as audience and
// receive no audio, which looks like a silent failure.

const DELIVERY_CHOICES = [
  { name: 'DM me only', value: 'me' },
  { name: 'DM everyone who spoke', value: 'everyone' },
  { name: 'Post in a channel', value: 'channel' },
];

// Discord caps choice names at 100 characters, which the descriptions stay well
// under; they are joined so the picker explains each format without a lookup.
const FORMAT_CHOICES = NOTE_FORMATS.map((f) => ({
  name: `${f.label} — ${f.description}`.slice(0, 100),
  value: f.value,
}));

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
    )
    .addStringOption((opt) =>
      opt
        .setName('format')
        .setDescription('How the notes are written for this meeting (overrides your /config default)')
        .setRequired(false)
        .addChoices(...FORMAT_CHOICES)
    ),

  new SlashCommandBuilder()
    .setName('leave')
    .setDescription('Stop recording, write up the notes, and deliver them as configured'),

  new SlashCommandBuilder()
    .setName('status')
    .setDescription('Show the current note-taking session and whether the local models are up'),

  new SlashCommandBuilder()
    .setName('config')
    .setDescription('Set your meeting-notes defaults for this server (leave blank to see them)')
    .addStringOption((opt) =>
      opt
        .setName('delivery')
        .setDescription('Who should get the notes by default')
        .setRequired(false)
        .addChoices(...DELIVERY_CHOICES)
    )
    .addChannelOption((opt) =>
      opt
        .setName('delivery-channel')
        .setDescription('Channel to post notes in, required when delivery is "Post in a channel"')
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(false)
    )
    .addStringOption((opt) =>
      opt
        .setName('format')
        .setDescription('How the notes should be written by default')
        .setRequired(false)
        .addChoices(...FORMAT_CHOICES)
    ),
].map((c) => c.toJSON());
