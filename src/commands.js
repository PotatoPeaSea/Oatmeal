import { SlashCommandBuilder, ChannelType } from 'discord.js';

// Stage channels are deliberately excluded: the bot would join as audience and
// receive no audio, which looks like a silent failure.

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
    ),

  new SlashCommandBuilder()
    .setName('leave')
    .setDescription('Stop recording, write up the notes, and DM them to whoever started the session'),

  new SlashCommandBuilder()
    .setName('status')
    .setDescription('Show the current note-taking session and whether the local models are up'),
].map((c) => c.toJSON());
