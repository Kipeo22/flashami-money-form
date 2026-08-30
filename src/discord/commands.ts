import { PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';

import { COMMANDS } from './ids.js';

export const commandDefinitions = [
  new SlashCommandBuilder()
    .setName(COMMANDS.postForm)
    .setDescription('このチャンネルに支出登録ボタンを設置します')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder()
    .setName(COMMANDS.refresh)
    .setDescription('Google Sheetsの精算・予算集計を再計算します')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
].map((command) => command.toJSON());
