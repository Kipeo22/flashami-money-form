import { createPublicKey, verify } from 'node:crypto';

import type { Logger } from 'pino';

import type { AppConfig } from '../config.js';
import { parseAmountYen } from '../domain/amount.js';
import { classifyTargets, TargetSelectionError } from '../domain/target.js';
import type { EventRecord, Expense, Person } from '../domain/types.js';
import { ExpenseConflictError } from '../gas/repository.js';
import { buildChannelExpenseModal, buildExpenseModal } from './components.js';
import { COMMANDS, COMPONENTS, expenseContextFromModal, eventIdFromComponent } from './ids.js';

const MAX_RECEIPT_BYTES = 20 * 1000 * 1000;
const MAX_GAS_BINARY_BYTES = 8 * 1024 * 1024;
const EPHEMERAL = 64;
const DISCORD_API_BASE = 'https://discord.com/api/v10';
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const allowedReceiptExtensions = new Set(['.jpg', '.jpeg', '.png', '.webp', '.heic', '.pdf']);

type JsonObject = Record<string, unknown>;
type DeferredTask = (promise: Promise<unknown>) => void;
type FetchImplementation = typeof fetch;

export type InteractionDependencies = {
  config: AppConfig;
  repository: InteractionRepository;
  logger: Pick<Logger, 'error'>;
  deferTask: DeferredTask;
  fetchImplementation?: FetchImplementation;
};

export type InteractionRepository = {
  getEvent(eventId: string): Promise<EventRecord | null>;
  findActiveEvent(discordGuildId: string, discordChannelId: string): Promise<EventRecord | null>;
  saveExpense(
    expense: Expense,
    eventFolderId: string,
    receipt: { buffer: Buffer; filename: string; mimeType: string } | null,
  ): Promise<{ id: string; url: string } | null>;
  refreshAggregations(): Promise<void>;
};

export async function handleDiscordInteraction(
  request: Request,
  dependencies: InteractionDependencies,
): Promise<Response> {
  if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

  const rawBody = await request.text();
  if (!verifyDiscordRequest(request.headers, rawBody, dependencies.config.discord.publicKey)) {
    return new Response('invalid request signature', { status: 401 });
  }

  let interaction: JsonObject;
  try {
    interaction = requiredRecord(JSON.parse(rawBody), 'Interaction');
  } catch {
    return new Response('invalid JSON body', { status: 400 });
  }

  try {
    const type = requiredNumber(interaction.type, 'Interaction type');
    if (type === 1) return jsonResponse({ type: 1 });
    if (type === 2) return handleCommand(interaction, dependencies);
    if (type === 3) return handleButton(interaction);
    if (type === 5) return handleModalSubmit(interaction, dependencies);
    return jsonResponse({ type: 4, data: { content: '未対応の操作です。', flags: EPHEMERAL } });
  } catch (error) {
    dependencies.logger.error({ err: error }, 'interaction response failed');
    return immediateError(error);
  }
}

function handleCommand(interaction: JsonObject, dependencies: InteractionDependencies): Response {
  const data = requiredRecord(interaction.data, 'Interaction data');
  const commandName = requiredString(data.name, 'Command name');
  const channelId = requiredString(interaction.channel_id, 'Discordチャンネル');

  if (commandName === COMMANDS.registerExpense) {
    return jsonResponse({ type: 9, data: buildChannelExpenseModal(channelId).toJSON() });
  }
  if (commandName === COMMANDS.refresh) {
    scheduleDeferredInteraction(interaction, dependencies, async () => {
      const event = await resolveEventForChannel(interaction, channelId, dependencies.repository);
      if (!memberHasRole(interaction, event.operationsRoleId)) {
        throw new UserInputError('運営ロールのメンバーだけが集計を更新できます。');
      }
      await dependencies.repository.refreshAggregations();
      return { content: '精算表と予算集計を更新しました。' };
    });
    return deferredResponse();
  }
  throw new UserInputError('未対応のコマンドです。');
}

function handleButton(interaction: JsonObject): Response {
  const data = requiredRecord(interaction.data, 'Interaction data');
  const customId = requiredString(data.custom_id, 'Component ID');
  const eventId = eventIdFromComponent(customId, COMPONENTS.openExpenseModalPrefix);
  if (!eventId) throw new UserInputError('このボタンは現在利用できません。');
  return jsonResponse({ type: 9, data: buildExpenseModal(eventId, 'イベント').toJSON() });
}

function handleModalSubmit(
  interaction: JsonObject,
  dependencies: InteractionDependencies,
): Response {
  scheduleDeferredInteraction(interaction, dependencies, () =>
    processExpenseModal(interaction, dependencies),
  );
  return deferredResponse();
}

function scheduleDeferredInteraction(
  interaction: JsonObject,
  dependencies: InteractionDependencies,
  task: () => Promise<EditReply>,
): void {
  const token = requiredString(interaction.token, 'Interaction token');
  const applicationId = requiredString(interaction.application_id, 'Application ID');
  const fetchImplementation = dependencies.fetchImplementation ?? fetch;
  dependencies.deferTask(
    task()
      .then(async (reply) => {
        try {
          await editOriginalReply(applicationId, token, reply, fetchImplementation);
        } finally {
          await reply.afterReply?.();
        }
      })
      .catch(async (error: unknown) => {
        dependencies.logger.error(
          { err: error, interactionId: interaction.id },
          'deferred interaction failed',
        );
        await editOriginalReply(
          applicationId,
          token,
          { content: `⚠️ ${userFacingError(error)}` },
          fetchImplementation,
        ).catch((replyError: unknown) => {
          dependencies.logger.error({ err: replyError }, 'Discord error response failed');
        });
      }),
  );
}

async function processExpenseModal(
  interaction: JsonObject,
  dependencies: InteractionDependencies,
): Promise<EditReply> {
  const data = requiredRecord(interaction.data, 'Modal data');
  const context = expenseContextFromModal(requiredString(data.custom_id, 'Modal ID'));
  if (!context) throw new UserInputError('このフォームは現在利用できません。');
  const guildId = requiredString(interaction.guild_id, 'Discordサーバー');
  const channelId = requiredString(interaction.channel_id, 'Discordチャンネル');
  if (context.type === 'channel' && context.channelId !== channelId) {
    throw new UserInputError('フォームを開いたチャンネルから登録してください。');
  }

  const components = modalComponents(data);
  const resolved = optionalRecord(data.resolved) ?? {};
  const receipt = selectedAttachment(components, resolved);
  if (receipt) validateReceipt(receipt);
  const [event, preparedReceipt] = await Promise.all([
    context.type === 'event'
      ? dependencies.repository.getEvent(context.eventId)
      : dependencies.repository.findActiveEvent(guildId, channelId),
    receipt ? downloadReceipt(receipt, dependencies.fetchImplementation ?? fetch) : null,
  ]);
  validateEvent(event, guildId, channelId);

  const payerId = singleSelectedValue(components, COMPONENTS.payer, '支払者');
  const targetIds = selectedValues(components, COMPONENTS.targets);
  const users = optionalRecord(resolved.users) ?? {};
  const members = optionalRecord(resolved.members) ?? {};
  const roles = optionalRecord(resolved.roles) ?? {};
  const payerUser = requiredRecord(users[payerId], '支払者');
  const targetUsers = targetIds
    .filter((id) => users[id] !== undefined)
    .map((id) => toPerson(requiredRecord(users[id], '対象者'), optionalRecord(members[id])));
  const targetRoleIds = targetIds.filter((id) => roles[id] !== undefined);
  const target = parseTargets(targetUsers, targetRoleIds, event.operationsRoleId);
  const item = componentValue(components, COMPONENTS.item).trim();
  if (!item) throw new UserInputError('「なにを？」を入力してください。');
  const amountYen = parseAmountForUser(componentValue(components, COMPONENTS.amount));
  const submitter = submittedBy(interaction);

  const expense: Expense = {
    id: requiredString(interaction.id, 'Interaction ID'),
    event: { id: event.id, name: event.name },
    createdAt: snowflakeTimestamp(requiredString(interaction.id, 'Interaction ID')).toISOString(),
    guildId,
    channelId,
    submittedBy: submitter,
    payer: toPerson(payerUser, optionalRecord(members[payerId])),
    target,
    item,
    amountYen,
    receiptFileId: '',
    receiptUrl: '',
    receiptName: preparedReceipt?.name ?? '',
  };

  try {
    const uploaded = await dependencies.repository.saveExpense(
      expense,
      event.driveFolderId,
      preparedReceipt
        ? {
            buffer: preparedReceipt.buffer,
            filename: buildReceiptFilename(expense.id, preparedReceipt.name),
            mimeType: preparedReceipt.mimeType,
          }
        : null,
    );
    expense.receiptFileId = uploaded?.id ?? '';
    expense.receiptUrl = uploaded?.url ?? '';
  } catch (error) {
    if (error instanceof ExpenseConflictError) {
      return { content: 'この支出はすでに登録済みです。二重登録は行いませんでした。' };
    }
    throw error;
  }

  const targetText =
    expense.target.type === 'operations'
      ? '運営'
      : expense.target.members.map(({ name }) => name).join('、');
  const content = [
    `「${expense.event.name}」に支出を登録しました。`,
    `誰が？ ${expense.payer.name}`,
    `誰の？ ${targetText}`,
    `何を？ ${expense.item}`,
    `いくら？ ${expense.amountYen.toLocaleString('ja-JP')}円`,
    preparedReceipt ? 'レシート:' : 'レシート: なし',
  ].join('\n');

  const afterReply = () =>
    dependencies.repository.refreshAggregations().catch((error: unknown) => {
      dependencies.logger.error(
        { err: error, expenseId: expense.id },
        'aggregation refresh failed',
      );
    });
  return preparedReceipt
    ? {
        content,
        file: {
          buffer: preparedReceipt.buffer,
          name: preparedReceipt.name,
          mimeType: preparedReceipt.mimeType,
        },
        afterReply,
      }
    : { content, afterReply };
}

function verifyDiscordRequest(headers: Headers, body: string, publicKeyHex: string): boolean {
  const signatureHex = headers.get('x-signature-ed25519');
  const timestamp = headers.get('x-signature-timestamp');
  if (!signatureHex || !timestamp || !/^[a-fA-F0-9]{128}$/.test(signatureHex)) return false;
  try {
    const publicKey = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKeyHex, 'hex')]),
      format: 'der',
      type: 'spki',
    });
    return verify(null, Buffer.from(timestamp + body), publicKey, Buffer.from(signatureHex, 'hex'));
  } catch {
    return false;
  }
}

type EditReply = {
  content: string;
  file?: { buffer: Buffer; name: string; mimeType: string };
  afterReply?: () => Promise<void>;
};

async function editOriginalReply(
  applicationId: string,
  token: string,
  reply: EditReply,
  fetchImplementation: FetchImplementation,
): Promise<void> {
  const url = `${DISCORD_API_BASE}/webhooks/${applicationId}/${token}/messages/@original`;
  let response: Response;
  if (reply.file) {
    const form = new FormData();
    form.set(
      'payload_json',
      JSON.stringify({
        content: reply.content,
        attachments: [{ id: 0, filename: reply.file.name }],
      }),
    );
    form.set(
      'files[0]',
      new Blob([new Uint8Array(reply.file.buffer)], { type: reply.file.mimeType }),
      reply.file.name,
    );
    response = await fetchImplementation(url, { method: 'PATCH', body: form });
  } else {
    response = await fetchImplementation(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: reply.content }),
    });
  }
  if (!response.ok) throw new Error(`Discord応答の更新に失敗しました (${response.status})。`);
}

function deferredResponse(): Response {
  return jsonResponse({ type: 5 });
}

function immediateError(error: unknown): Response {
  return jsonResponse({
    type: 4,
    data: { content: `⚠️ ${userFacingError(error)}`, flags: EPHEMERAL },
  });
}

function userFacingError(error: unknown): string {
  return error instanceof UserInputError
    ? error.message
    : 'ふらしゃみくんパンクしちゃうしゃみ〜！エラーが続く場合は運営に連絡するしゃみ〜';
}

function jsonResponse(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
}

function modalComponents(data: JsonObject): JsonObject[] {
  const components = Array.isArray(data.components) ? data.components : [];
  return components.flatMap((entry) => {
    const outer = optionalRecord(entry);
    if (!outer) return [];
    const child = optionalRecord(outer.component);
    return child ? [child] : [outer];
  });
}

function findComponent(components: JsonObject[], customId: string): JsonObject {
  const component = components.find((entry) => entry.custom_id === customId);
  if (!component) throw new UserInputError('フォームの入力項目が不足しています。');
  return component;
}

function componentValue(components: JsonObject[], customId: string): string {
  return requiredString(findComponent(components, customId).value, customId);
}

function selectedValues(components: JsonObject[], customId: string): string[] {
  const values = findComponent(components, customId).values;
  if (!Array.isArray(values) || !values.every((value) => typeof value === 'string')) {
    throw new UserInputError('フォームの選択内容が不正です。');
  }
  return values;
}

function singleSelectedValue(components: JsonObject[], customId: string, label: string): string {
  const values = selectedValues(components, customId);
  if (values.length !== 1) throw new UserInputError(`${label}を1人選択してください。`);
  return values[0] ?? '';
}

type RawAttachment = {
  name: string;
  size: number;
  url: string;
  contentType: string | null;
};

function selectedAttachment(components: JsonObject[], resolved: JsonObject): RawAttachment | null {
  const component = findComponent(components, COMPONENTS.receipt);
  const values = component.values;
  if (!Array.isArray(values) || values.length === 0) return null;
  const id = typeof values[0] === 'string' ? values[0] : '';
  const attachments = optionalRecord(resolved.attachments) ?? {};
  const attachment = requiredRecord(attachments[id], 'レシート');
  return {
    name: requiredString(attachment.filename, 'レシート名'),
    size: requiredNumber(attachment.size, 'レシートサイズ'),
    url: requiredString(attachment.url, 'レシートURL'),
    contentType: typeof attachment.content_type === 'string' ? attachment.content_type : null,
  };
}

async function resolveEventForChannel(
  interaction: JsonObject,
  channelId: string,
  repository: InteractionRepository,
): Promise<EventRecord> {
  const guildId = requiredString(interaction.guild_id, 'Discordサーバー');
  const event = await repository.findActiveEvent(guildId, channelId);
  if (!event) throw new UserInputError('このチャンネルに有効なイベントがありません。');
  return event;
}

function validateEvent(
  event: EventRecord | null,
  guildId: string,
  channelId: string,
): asserts event is EventRecord {
  if (!event || event.status !== 'active') {
    throw new UserInputError('このイベントは現在利用できません。');
  }
  if (event.discordGuildId !== guildId || event.discordChannelId !== channelId) {
    throw new UserInputError('このイベントが設定されたDiscordチャンネルから登録してください。');
  }
}

function memberHasRole(interaction: JsonObject, roleId: string): boolean {
  const member = optionalRecord(interaction.member);
  return Array.isArray(member?.roles) && member.roles.includes(roleId);
}

function submittedBy(interaction: JsonObject): Person {
  const member = optionalRecord(interaction.member);
  const user = requiredRecord(member?.user ?? interaction.user, '登録者');
  return toPerson(user, member);
}

function toPerson(user: JsonObject, member?: JsonObject | null): Person {
  const id = requiredString(user.id, 'ユーザーID');
  const username = requiredString(user.username, 'ユーザー名');
  const nickname = typeof member?.nick === 'string' ? member.nick : null;
  const globalName = typeof user.global_name === 'string' ? user.global_name : null;
  return { id, name: nickname ?? globalName ?? username };
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

function validateReceipt(receipt: RawAttachment): void {
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
  receipt: RawAttachment,
  fetchImplementation: FetchImplementation,
): Promise<{ buffer: Buffer; name: string; mimeType: string }> {
  const response = await fetchImplementation(receipt.url, {
    signal: AbortSignal.timeout(30_000),
  });
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
    const { default: sharp } = await import('sharp');
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

function snowflakeTimestamp(id: string): Date {
  try {
    return new Date(Number((BigInt(id) >> 22n) + 1_420_070_400_000n));
  } catch {
    return new Date();
  }
}

function formatMiB(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(2);
}

function optionalRecord(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function requiredRecord(value: unknown, label: string): JsonObject {
  const record = optionalRecord(value);
  if (!record) throw new UserInputError(`${label}が不正です。`);
  return record;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value) throw new UserInputError(`${label}が不正です。`);
  return value;
}

function requiredNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new UserInputError(`${label}が不正です。`);
  }
  return value;
}

class UserInputError extends Error {}
