import { REST, Routes } from 'discord.js';

import { loadConfig } from '../src/config.js';
import { commandDefinitions } from '../src/discord/commands.js';

const config = loadConfig();
const rest = new REST({ version: '10' }).setToken(config.discord.token);

await rest.put(Routes.applicationGuildCommands(config.discord.clientId, config.discord.guildId), {
  body: commandDefinitions,
});

console.log(`Discordサーバー ${config.discord.guildId} にコマンドを登録しました。`);
