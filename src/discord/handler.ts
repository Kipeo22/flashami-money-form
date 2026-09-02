import { Events, MessageFlags } from 'discord.js';
import type {
  Attachment,
  BaseInteraction,
  ChatInputCommandInteraction,
  Client,
  ModalSubmitInteraction,
  User,
} from 'discord.js';
import type { Logger } from 'pino';
import sharp from 'sharp';

import { parseAmountYen } from '../domain/amount.js';
import { classifyTargets, TargetSelectionError } from '../domain/target.js';
import type { Expense, Person } from '../domain/types.js';
import type { GasRepository } from '../gas/repository.js';
import { buildExpenseButtonRow, buildExpenseModal } from './components.js';
import { COMMANDS, COMPONENTS, eventIdFromComponent } from './ids.js';

const MAX_RECEIPT_BYTES = 20 * 1000 * 1000;
const MAX_GAS_BINARY_BYTES = 8 * 1024 * 1024;
const allowedReceiptExtensions = new Set(['.jpg', '.jpeg', '.png', '.webp', '.heic', '.pdf']);

export function registerInteractionHandler(
  client: Client,
  repository: GasRepository,
  logger: Logger,
): void {
  const queue = new SerialQueue();
  const eventNames = new Map<string, string>();

  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      if (interaction.isChatInputCommand()) {
        if (interaction.commandName === COMMANDS.registerExpense) {
          const guildId = requiredContext(interaction.guildId, 'Discordサーバー');
          const channelId = requiredContext(interaction.channelId, 'Discordチャンネル');
          const event = repository.findCachedActiveEvent(guildId, channelId);
          if (!event) {
            throw new UserInputError('このチャンネルに有効なイベントがありません。');
          }
          eventNames.set(event.id, event.name);
          await interaction.showModal(buildExpenseModal(event.id, event.name));
          return;
        }

        if (interaction.commandName === COMMANDS.postForm) {
          const guildId = requiredContext(interaction.guildId, 'Discordサーバー');
          const channelId = requiredContext(interaction.channelId, 'Discordチャンネル');
          await interaction.deferReply();
          const event = await repository.findActiveEvent(guildId, channelId);
          if (!event) {
            throw new UserInputError(
              'このチャンネルに有効なイベントがありません。先にWeb管理画面でイベントを作成してください。',
            );
          }
          eventNames.set(event.id, event.name);
          await interaction.editReply({
            content: [
              `### ${event.name}の支出登録`,
              'ボタンから支払者・対象者・内容・金額・レシートを入力してください。',
              `共通予算から出す支出は「誰の分？」で <@&${event.operationsRoleId}> だけを選択します。`,
            ].join('\n'),
            components: [buildExpenseButtonRow(event.id)],
            allowedMentions: { parse: [] },
          });
          return;
        }

        if (interaction.commandName === COMMANDS.refresh) {
          await interaction.deferReply();
          const guildId = requiredContext(interaction.guildId, 'Discordサーバー');
          const channelId = requiredContext(interaction.channelId, 'Discordチャンネル');
          const event = await repository.findActiveEvent(guildId, channelId);
          if (!event) {
            throw new UserInputError('このチャンネルに有効なイベントがありません。');
          }
          if (!memberHasRole(interaction, event.operationsRoleId)) {
            throw new UserInputError('運営ロールのメンバーだけが集計を更新できます。');
          }
          await queue.run(() => repository.refreshAggregations());
          await interaction.editReply('精算表と予算集計を更新しました。');
          return;
        }
      }

      if (interaction.isButton()) {
        const eventId = eventIdFromComponent(
          interaction.customId,
          COMPONENTS.openExpenseModalPrefix,
        );
        if (!eventId) return;
        await interaction.showModal(
          buildExpenseModal(eventId, eventNames.get(eventId) ?? 'イベント'),
        );
        return;
      }

      if (interaction.isModalSubmit()) {
        const eventId = eventIdFromComponent(interaction.customId, COMPONENTS.expenseModalPrefix);
        if (!eventId) return;
        await handleExpenseModal(interaction, eventId, repository, logger, queue);
      }
    } catch (error) {
      logger.error({ err: error, interactionId: interaction.id }, 'interaction failed');
      await respondWithError(interaction, error);
    }
  });
}

async function handleExpenseModal(
  interaction: ModalSubmitInteraction,
  eventId: string,
  repository: GasRepository,
  logger: Logger,
  queue: SerialQueue,
): Promise<void> {
  await interaction.deferReply();

  const event = await repository.getEvent(eventId);
  if (!event || event.status !== 'active') {
    throw new UserInputError('このイベントは現在利用できません。');
  }
  if (interaction.guildId !== event.discordGuildId) {
    throw new UserInputError('このイベントが設定されたDiscordサーバーから登録してください。');
  }

  const payerUser = firstUser(interaction.fields.getSelectedUsers(COMPONENTS.payer, true));
  const selectedPayerMembers = interaction.fields.getSelectedMembers(COMPONENTS.payer);
  const selectedTargets = interaction.fields.getSelectedMentionables(COMPONENTS.targets, true);
  const selectedTargetMembers = interaction.fields.getSelectedMembers(COMPONENTS.targets);
  const target = parseTargets(
    [...selectedTargets.users.values()].map((user) =>
      toPerson(user, selectedTargetMembers?.get(user.id)),
    ),
    [...selectedTargets.roles.keys()],
    event.operationsRoleId,
  );
  const item = interaction.fields.getTextInputValue(COMPONENTS.item).trim();
  if (!item) throw new UserInputError('「なにを？」を入力してください。');
  const amountYen = parseAmountForUser(interaction.fields.getTextInputValue(COMPONENTS.amount));
  const receipt = interaction.fields.getUploadedFiles(COMPONENTS.receipt)?.first() ?? null;
  if (receipt) validateReceipt(receipt);
  const preparedReceipt = receipt ? await downloadReceipt(receipt) : null;

  const result = await queue.run(async () => {
    if (await repository.hasExpense(interaction.id, event.id)) return { duplicate: true } as const;

    const uploaded = preparedReceipt
      ? await repository.uploadReceipt(
          {
            buffer: preparedReceipt.buffer,
            filename: buildReceiptFilename(interaction.id, preparedReceipt.name),
            mimeType: preparedReceipt.mimeType,
          },
          event.driveFolderId,
        )
      : null;

    const expense: Expense = {
      id: interaction.id,
      event: { id: event.id, name: event.name },
      createdAt: new Date(interaction.createdTimestamp).toISOString(),
      guildId: requiredContext(interaction.guildId, 'Discordサーバー'),
      channelId: requiredContext(interaction.channelId, 'Discordチャンネル'),
      submittedBy: toPerson(interaction.user, interaction.member),
      payer: toPerson(payerUser, selectedPayerMembers?.get(payerUser.id)),
      target,
      item,
      amountYen,
      receiptFileId: uploaded?.id ?? '',
      receiptUrl: uploaded?.url ?? '',
      receiptName: preparedReceipt?.name ?? '',
    };

    try {
      await repository.appendExpense(expense);
    } catch (error) {
      if (uploaded) {
        await repository.deleteDriveItem(uploaded.id).catch((cleanupError: unknown) => {
          logger.error({ err: cleanupError, fileId: uploaded.id }, 'receipt rollback failed');
        });
      }
      throw error;
    }

    try {
      await repository.refreshAggregations();
    } catch (error) {
      logger.error({ err: error, expenseId: expense.id }, 'aggregation refresh failed');
    }
    return { duplicate: false, expense } as const;
  });

  if (result.duplicate) {
    await interaction.editReply('この支出はすでに登録済みです。二重登録は行いませんでした。');
    return;
  }

  const targetText =
    result.expense.target.type === 'operations'
      ? '運営（共通予算）'
      : result.expense.target.members.map(({ name }) => name).join('、');
  const lines = [
    `「${result.expense.event.name}」に支出を登録しました。`,
    `誰が？ ${result.expense.payer.name}`,
    `誰の？ ${targetText}`,
    `何を？ ${result.expense.item}`,
    `いくら？ ${result.expense.amountYen.toLocaleString('ja-JP')}円`,
    `レシート: ${receipt ? '添付あり' : 'なし'}`,
  ];
  const content = lines.join('\n');
  if (preparedReceipt) {
    await interaction.editReply({
      content,
      files: [{ attachment: preparedReceipt.buffer, name: preparedReceipt.name }],
    });
  } else {
    await interaction.editReply({ content });
  }
}

function memberHasRole(interaction: ChatInputCommandInteraction, roleId: string): boolean {
  const roles = interaction.member?.roles;
  if (!roles) return false;
  return Array.isArray(roles) ? roles.includes(roleId) : roles.cache.has(roleId);
}

function parseTargets(users: Person[], roleIds: string[], operationsRoleId: string) {
  try {
    return classifyTargets(users, roleIds, operationsRoleId);
  } catch (error) {
    if (error instanceof TargetSelectionError) throw new UserInputError(error.message);
    throw error;
  }
}

function parseAmountForUser(raw: string): number {
  try {
    return parseAmountYen(raw);
  } catch (error) {
    if (error instanceof Error) throw new UserInputError(error.message);
    throw error;
  }
}

function validateReceipt(receipt: Attachment): void {
  if (receipt.size > MAX_RECEIPT_BYTES) {
    throw new UserInputError(
      `レシートは20 MB以下にしてください（Discord検出: ${formatMiB(receipt.size)} MiB）。`,
    );
  }
  const extension = receipt.name.slice(receipt.name.lastIndexOf('.')).toLowerCase();
  const validMime =
    receipt.contentType?.startsWith('image/') || receipt.contentType === 'application/pdf';
  if (!validMime && !allowedReceiptExtensions.has(extension)) {
    throw new UserInputError('レシートは画像（JPG・PNG・WebP・HEIC）またはPDFにしてください。');
  }
}

async function downloadReceipt(
  receipt: Attachment,
): Promise<{ buffer: Buffer; name: string; mimeType: string }> {
  const response = await fetch(receipt.url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok)
    throw new Error(`Discordからレシートを取得できませんでした (${response.status})。`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > MAX_RECEIPT_BYTES) {
    throw new UserInputError(
      `レシートは20 MB以下にしてください（取得後: ${formatMiB(buffer.byteLength)} MiB）。`,
    );
  }
  const mimeType = receipt.contentType ?? inferMimeType(receipt.name);
  if (!mimeType.startsWith('image/')) {
    if (buffer.byteLength > MAX_GAS_BINARY_BYTES) {
      throw new UserInputError(
        `PDFレシートは8 MiB以下にしてください（取得後: ${formatMiB(buffer.byteLength)} MiB）。`,
      );
    }
    return { buffer, name: receipt.name, mimeType };
  }
  if (buffer.byteLength <= MAX_GAS_BINARY_BYTES) {
    return { buffer, name: receipt.name, mimeType };
  }

  let optimized: Buffer;
  try {
    optimized = await sharp(buffer)
      .rotate()
      .resize({ width: 2400, height: 2400, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 82, mozjpeg: true })
      .toBuffer();
  } catch {
    throw new UserInputError(
      'レシート画像を最適化できませんでした。別の画像形式で再試行してください。',
    );
  }
  if (optimized.byteLength > MAX_GAS_BINARY_BYTES) {
    throw new UserInputError(
      `画像最適化後も容量が大きすぎます（${formatMiB(optimized.byteLength)} MiB）。`,
    );
  }
  return {
    buffer: optimized,
    name: `${receipt.name.replace(/\.[^.]+$/, '') || 'receipt'}.jpg`,
    mimeType: 'image/jpeg',
  };
}

function formatMiB(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(2);
}

function buildReceiptFilename(interactionId: string, originalName: string): string {
  const safeName = originalName
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}._-]+/gu, '_')
    .slice(-120);
  return `${new Date().toISOString().slice(0, 10)}_${interactionId}_${safeName || 'receipt'}`;
}

function inferMimeType(filename: string): string {
  const extension = filename.toLowerCase().slice(filename.lastIndexOf('.'));
  return (
    {
      '.pdf': 'application/pdf',
      '.png': 'image/png',
      '.webp': 'image/webp',
      '.heic': 'image/heic',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
    }[extension] ?? 'application/octet-stream'
  );
}

function firstUser(users: ReadonlyMap<string, User>): User {
  const user = users.values().next().value;
  if (!user) throw new UserInputError('支払者を選択してください。');
  return user;
}

function toPerson(user: User, member?: unknown): Person {
  if (member && typeof member === 'object') {
    if ('displayName' in member && typeof member.displayName === 'string') {
      return { id: user.id, name: member.displayName };
    }
    if ('nick' in member && typeof member.nick === 'string') {
      return { id: user.id, name: member.nick };
    }
  }
  return { id: user.id, name: user.globalName ?? user.username };
}

function requiredContext(value: string | null, label: string): string {
  if (!value) throw new UserInputError(`${label}内から登録してください。`);
  return value;
}

async function respondWithError(interaction: BaseInteraction, error: unknown): Promise<void> {
  if (!interaction.isRepliable()) return;
  const message =
    error instanceof UserInputError
      ? error.message
      : 'ふらしゃみくんパンクしちゃうしゃみ〜！エラーが続く場合は運営に連絡するしゃみ〜';
  const options = { content: `⚠️ ${message}`, flags: MessageFlags.Ephemeral } as const;
  if (interaction.deferred || interaction.replied) {
    await interaction.editReply({ content: options.content }).catch(() => undefined);
  } else {
    await interaction.reply(options).catch(() => undefined);
  }
}

class UserInputError extends Error {}

class SerialQueue {
  private tail: Promise<void> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
