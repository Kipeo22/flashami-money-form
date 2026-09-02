import { SlashCommandBuilder } from 'discord.js';

import { COMMANDS } from './ids.js';

export const commandDefinitions = [
  new SlashCommandBuilder()
    .setName(COMMANDS.registerExpense)
    .setDescription('支出登録フォームを開きます'),
  new SlashCommandBuilder()
    .setName(COMMANDS.refresh)
    .setDescription('Google Sheetsの精算・予算集計を再計算します')
    .setDefaultMemberPermissions(0),
].map((command) => command.toJSON());
