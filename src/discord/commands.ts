import { SlashCommandBuilder } from 'discord.js';

import { COMMANDS } from './ids.js';

export const commandDefinitions = [
  new SlashCommandBuilder()
    .setName(COMMANDS.registerExpense)
    .setDescription('支出登録フォームを開きます'),
].map((command) => command.toJSON());
