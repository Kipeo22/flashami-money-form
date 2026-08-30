import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  FileUploadBuilder,
  LabelBuilder,
  MentionableSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  UserSelectMenuBuilder,
} from 'discord.js';

import { COMPONENTS, expenseButtonId, expenseModalId } from './ids.js';

export function buildExpenseButtonRow(eventId: string) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(expenseButtonId(eventId))
      .setLabel('支出を登録')
      .setEmoji('🧾')
      .setStyle(ButtonStyle.Primary),
  );
}

export function buildExpenseModal(eventId: string, eventName: string): ModalBuilder {
  const payer = new LabelBuilder()
    .setLabel('誰が？')
    .setDescription('実際に支払いをした人を選択してください')
    .setUserSelectMenuComponent(
      new UserSelectMenuBuilder()
        .setCustomId(COMPONENTS.payer)
        .setMinValues(1)
        .setMaxValues(1)
        .setRequired(true),
    );

  const targets = new LabelBuilder()
    .setLabel('誰の分？')
    .setDescription('参加者、または共通予算から出す場合は @運営 のみを選択')
    .setMentionableSelectMenuComponent(
      new MentionableSelectMenuBuilder()
        .setCustomId(COMPONENTS.targets)
        .setMinValues(1)
        .setMaxValues(25)
        .setRequired(true),
    );

  const item = new LabelBuilder()
    .setLabel('なにを？')
    .setTextInputComponent(
      new TextInputBuilder()
        .setCustomId(COMPONENTS.item)
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('例: ガソリン代')
        .setMinLength(1)
        .setMaxLength(100)
        .setRequired(true),
    );

  const amount = new LabelBuilder()
    .setLabel('金額')
    .setDescription('日本円の税込総額を入力してください')
    .setTextInputComponent(
      new TextInputBuilder()
        .setCustomId(COMPONENTS.amount)
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('例: 12500')
        .setMinLength(1)
        .setMaxLength(20)
        .setRequired(true),
    );

  const receipt = new LabelBuilder()
    .setLabel('レシート')
    .setDescription('画像またはPDFを1ファイル添付してください（最大10 MiB）')
    .setFileUploadComponent(
      new FileUploadBuilder()
        .setCustomId(COMPONENTS.receipt)
        .setMinValues(1)
        .setMaxValues(1)
        .setRequired(true),
    );

  return new ModalBuilder()
    .setCustomId(expenseModalId(eventId))
    .setTitle(`${eventName.slice(0, 36)}｜支出登録`)
    .addLabelComponents(payer, targets, item, amount, receipt);
}
