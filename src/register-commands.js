import { REST, Routes } from 'discord.js';
import { config, assertConfig } from './config.js';
import { commands } from './commands.js';

assertConfig();

const rest = new REST().setToken(config.token);

const route = config.guildId
  ? Routes.applicationGuildCommands(config.clientId, config.guildId)
  : Routes.applicationCommands(config.clientId);

await rest.put(route, { body: commands });

console.log(
  config.guildId
    ? `Registered ${commands.length} commands to guild ${config.guildId} (available immediately).`
    : `Registered ${commands.length} commands globally (can take up to an hour to appear).`
);
