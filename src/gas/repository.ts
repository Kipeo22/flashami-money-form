import { createHmac, randomUUID } from 'node:crypto';

import type { AppConfig } from '../config.js';
import { aggregateExpenses } from '../domain/settlement.js';
import type { CreateEventInput, EventRecord, Expense, Person } from '../domain/types.js';

const SETTLEMENT_HEADERS = [
  'イベントID',
  'イベント名',
  '支払元ID',
  '支払元',
  '支払先ID',
  '支払先',
  '金額(円)',
  '更新日時',
] as const;
const BUDGET_HEADERS = [
  'イベントID',
  'イベント名',
  '初期予算(円)',
  '使用額(円)',
  '残額(円)',
  '更新日時',
] as const;
const RETRYABLE_ACTIONS = new Set([
  'initialize',
  'listEvents',
  'readExpenses',
  'hasExpense',
  'replaceAggregations',
]);
const RETRY_DELAYS_MS = [0, 250] as const;

type ReceiptUpload = {
  buffer: Buffer;
  filename: string;
  mimeType: string;
};

type SavedReceipt = { id: string; url: string } | null;

type GasSuccess = { ok: true; data: unknown };
type GasFailure = { ok: false; error?: { code?: unknown; message?: unknown } };

export class GasRepository {
  private readonly webAppUrl: string;
  private readonly sharedSecret: string;
  private readonly fetchImplementation: typeof fetch;
  private cachedEvents: EventRecord[] = [];

  constructor(config: AppConfig, fetchImplementation: typeof fetch = fetch) {
    this.webAppUrl = config.gas.webAppUrl;
    this.sharedSecret = config.gas.sharedSecret;
    this.fetchImplementation = fetchImplementation;
  }

  async initialize(): Promise<void> {
    await this.request('initialize', {});
    await this.refreshAggregations();
  }

  async listEvents(): Promise<EventRecord[]> {
    const rows = parseRows(await this.request('listEvents', {}), 'イベント一覧');
    this.cachedEvents = rows
      .filter((row) => row.some((value) => value !== ''))
      .map(rowToEvent)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return this.cachedEvents;
  }

  findCachedActiveEvent(discordGuildId: string, discordChannelId: string): EventRecord | null {
    return (
      this.cachedEvents.find(
        (event) =>
          event.status === 'active' &&
          event.discordGuildId === discordGuildId &&
          event.discordChannelId === discordChannelId,
      ) ?? null
    );
  }

  async getEvent(eventId: string): Promise<EventRecord | null> {
    return (await this.listEvents()).find((event) => event.id === eventId) ?? null;
  }

  async findActiveEvent(
    discordGuildId: string,
    discordChannelId: string,
  ): Promise<EventRecord | null> {
    return (
      (await this.listEvents()).find(
        (event) =>
          event.status === 'active' &&
          event.discordGuildId === discordGuildId &&
          event.discordChannelId === discordChannelId,
      ) ?? null
    );
  }

  async createEvent(input: CreateEventInput): Promise<EventRecord> {
    try {
      const event = rowToEvent(parseRow(await this.request('createEvent', input), '作成イベント'));
      this.cachedEvents = [event, ...this.cachedEvents.filter(({ id }) => id !== event.id)];
      return event;
    } catch (error) {
      if (error instanceof GasApiError && error.code === 'EVENT_CONFLICT') {
        throw new EventConflictError(error.message);
      }
      if (
        error instanceof GasApiError &&
        ['SHEET_CONFLICT', 'SPREADSHEET_ACCESS', 'VALIDATION_ERROR', 'NOT_FOUND'].includes(
          error.code,
        )
      ) {
        throw new EventConfigurationError(error.message);
      }
      throw error;
    }
  }

  async hasExpense(expenseId: string, eventId: string): Promise<boolean> {
    const result = await this.request('hasExpense', { expenseId, eventId });
    if (typeof result !== 'boolean') throw new Error('GASから不正な支出確認結果が返されました。');
    return result;
  }

  async uploadReceipt(
    receipt: ReceiptUpload,
    eventFolderId: string,
  ): Promise<{ id: string; url: string }> {
    const result = await this.request('uploadReceipt', {
      eventFolderId,
      filename: receipt.filename,
      mimeType: receipt.mimeType,
      base64: receipt.buffer.toString('base64'),
    });
    if (!isRecord(result)) throw new Error('GASから不正なレシート保存結果が返されました。');
    return {
      id: requiredString(result.id, 'レシートファイルID'),
      url: requiredString(result.url, 'レシートURL'),
    };
  }

  async deleteDriveItem(fileId: string): Promise<void> {
    await this.request('deleteDriveItem', { fileId });
  }

  async appendExpense(expense: Expense): Promise<void> {
    try {
      await this.request('appendExpense', { row: expenseToRow(expense) });
    } catch (error) {
      if (error instanceof GasApiError && error.code === 'EXPENSE_CONFLICT') {
        throw new ExpenseConflictError(error.message);
      }
      if (error instanceof RetryableGasTransportError) {
        try {
          if (await this.hasExpense(expense.id, expense.event.id)) return;
        } catch {
          // Keep the original append error when reconciliation also fails.
        }
      }
      throw error;
    }
  }

  async saveExpense(
    expense: Expense,
    eventFolderId: string,
    receipt: ReceiptUpload | null,
  ): Promise<SavedReceipt> {
    try {
      const result = await this.request('saveExpense', {
        row: expenseToRow(expense),
        receipt: receipt
          ? {
              eventFolderId,
              filename: receipt.filename,
              mimeType: receipt.mimeType,
              base64: receipt.buffer.toString('base64'),
            }
          : null,
      });
      if (result === null) return null;
      if (!isRecord(result)) throw new Error('GASから不正なレシート保存結果が返されました。');
      return {
        id: requiredString(result.id, 'レシートファイルID'),
        url: requiredString(result.url, 'レシートURL'),
      };
    } catch (error) {
      if (error instanceof GasApiError && error.code === 'EXPENSE_CONFLICT') {
        throw new ExpenseConflictError(error.message);
      }
      if (error instanceof RetryableGasTransportError) {
        try {
          if (await this.hasExpense(expense.id, expense.event.id)) return null;
        } catch {
          // Keep the original save error when reconciliation also fails.
        }
      }
      throw error;
    }
  }

  async refreshAggregations(): Promise<void> {
    const [expenses, events] = await Promise.all([this.readExpenses(), this.listEvents()]);
    const updatedAt = new Date().toISOString();
    const settlementRows: Array<Array<string | number>> = [[...SETTLEMENT_HEADERS]];
    const budgetRows: Array<Array<string | number>> = [[...BUDGET_HEADERS]];

    for (const event of events) {
      const aggregation = aggregateExpenses(
        expenses.filter((expense) => expense.event.id === event.id),
      );
      settlementRows.push(
        ...aggregation.transfers.map((transfer) => [
          event.id,
          event.name,
          transfer.from.id,
          transfer.from.name,
          transfer.to.id,
          transfer.to.name,
          transfer.amountYen,
          updatedAt,
        ]),
      );
      budgetRows.push([
        event.id,
        event.name,
        event.initialBudgetYen,
        aggregation.operationsSpentYen,
        event.initialBudgetYen - aggregation.operationsSpentYen,
        updatedAt,
      ]);
    }

    await this.request('replaceAggregations', { settlementRows, budgetRows });
  }

  private async readExpenses(): Promise<Expense[]> {
    const rows = parseRows(await this.request('readExpenses', {}), '支出一覧');
    return rows
      .filter((row) => row.some((value) => value !== '') && row[17] && row[18])
      .map(rowToExpense);
  }

  private async request(action: string, payload: unknown): Promise<unknown> {
    const attempts = RETRYABLE_ACTIONS.has(action) ? RETRY_DELAYS_MS.length + 1 : 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (attempt > 0) await wait(RETRY_DELAYS_MS[attempt - 1] ?? 0);
      try {
        return await this.requestOnce(action, payload);
      } catch (error) {
        if (!(error instanceof RetryableGasTransportError) || attempt === attempts - 1) {
          throw error;
        }
      }
    }
    throw new Error('GASへの接続に失敗しました。');
  }

  private async requestOnce(action: string, payload: unknown): Promise<unknown> {
    const signedBody = JSON.stringify({
      version: 1,
      timestamp: Math.floor(Date.now() / 1000),
      nonce: randomUUID(),
      action,
      payload,
    });
    const signature = createHmac('sha256', this.sharedSecret)
      .update(signedBody)
      .digest('base64url');
    let response: Response;
    try {
      response = await this.fetchImplementation(this.webAppUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: signedBody, signature }),
        redirect: 'follow',
        signal: AbortSignal.timeout(120_000),
      });
    } catch {
      throw new RetryableGasTransportError('GASへ接続できませんでした。');
    }
    const responseText = await response.text();
    if (!response.ok) {
      const message = `GASへの接続に失敗しました (${response.status})。`;
      if ([404, 408, 429].includes(response.status) || response.status >= 500) {
        throw new RetryableGasTransportError(message);
      }
      throw new Error(message);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(responseText);
    } catch {
      throw new RetryableGasTransportError(
        'GASからJSON以外の応答が返されました。WebアプリのURLと公開範囲を確認してください。',
      );
    }
    if (!isRecord(parsed) || typeof parsed.ok !== 'boolean') {
      throw new Error('GASから不正な応答が返されました。');
    }
    if (!parsed.ok) {
      const failure = parsed as GasFailure;
      throw new GasApiError(
        typeof failure.error?.code === 'string' ? failure.error.code : 'GAS_ERROR',
        typeof failure.error?.message === 'string'
          ? failure.error.message
          : 'GASで処理に失敗しました。',
      );
    }
    return (parsed as GasSuccess).data;
  }
}

export class EventConflictError extends Error {}
export class EventConfigurationError extends Error {}
export class ExpenseConflictError extends Error {}

class GasApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

class RetryableGasTransportError extends Error {}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function expenseToRow(expense: Expense): Array<string | number> {
  const targetIds =
    expense.target.type === 'members' ? expense.target.members.map(({ id }) => id) : [];
  const targetNames =
    expense.target.type === 'members' ? expense.target.members.map(({ name }) => name) : [];
  return [
    expense.id,
    expense.createdAt,
    expense.guildId,
    expense.channelId,
    expense.submittedBy.id,
    expense.submittedBy.name,
    expense.payer.id,
    expense.payer.name,
    expense.target.type === 'operations' ? '運営' : '参加者',
    JSON.stringify(targetIds),
    JSON.stringify(targetNames),
    expense.target.type === 'operations' ? '運営' : targetNames.join('、'),
    expense.item,
    expense.amountYen,
    expense.receiptFileId,
    expense.receiptUrl,
    expense.receiptName,
    expense.event.id,
    expense.event.name,
  ];
}

function rowToEvent(row: unknown[]): EventRecord {
  const status = requiredString(row[8], '状態');
  if (status !== 'active' && status !== 'archived') {
    throw new Error('イベントシートの状態は active または archived にしてください。');
  }
  return {
    id: requiredString(row[0], 'イベントID'),
    name: requiredString(row[1], 'イベント名'),
    initialBudgetYen: parseNonNegativeInteger(row[2], '初期予算'),
    discordGuildId: requiredString(row[3], 'DiscordサーバーID'),
    discordChannelId: requiredString(row[4], 'DiscordチャンネルID'),
    operationsRoleId: requiredString(row[5], '運営ロールID'),
    driveFolderId: requiredString(row[6], 'DriveフォルダID'),
    spreadsheetId: requiredString(row[7], 'イベントスプレッドシートID'),
    status,
    createdAt: requiredString(row[9], '作成日時'),
  };
}

function rowToExpense(row: unknown[]): Expense {
  const targetType = requiredString(row[8], '対象区分');
  const ids = parseStringArray(row[9], '対象者ID(JSON)');
  const names = parseStringArray(row[10], '対象者名(JSON)');
  if (targetType === '参加者' && ids.length !== names.length) {
    throw new Error('支出シートの対象者IDと名前の数が一致しません。');
  }
  const members: Person[] =
    targetType === '運営' ? [] : ids.map((id, index) => ({ id, name: names[index] ?? id }));
  if (targetType !== '運営' && targetType !== '参加者') {
    throw new Error('支出シートの対象区分は「運営」または「参加者」にしてください。');
  }
  if (targetType === '参加者' && members.length === 0) {
    throw new Error('参加者向け支出に対象者が設定されていません。');
  }

  return {
    id: requiredString(row[0], '支出ID'),
    event: {
      id: requiredString(row[17], 'イベントID'),
      name: requiredString(row[18], 'イベント名'),
    },
    createdAt: requiredString(row[1], '登録日時'),
    guildId: requiredString(row[2], 'サーバーID'),
    channelId: requiredString(row[3], 'チャンネルID'),
    submittedBy: {
      id: requiredString(row[4], '登録者ID'),
      name: requiredString(row[5], '登録者'),
    },
    payer: {
      id: requiredString(row[6], '支払者ID'),
      name: requiredString(row[7], '支払者'),
    },
    target: targetType === '運営' ? { type: 'operations' } : { type: 'members', members },
    item: requiredString(row[12], '内容'),
    amountYen: parseNonNegativeInteger(row[13], '金額'),
    receiptFileId: optionalString(row[14]),
    receiptUrl: optionalString(row[15]),
    receiptName: optionalString(row[16]),
  };
}

function parseRows(value: unknown, label: string): unknown[][] {
  if (!Array.isArray(value) || !value.every(Array.isArray)) {
    throw new Error(`GASから不正な${label}が返されました。`);
  }
  return value;
}

function parseRow(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`GASから不正な${label}が返されました。`);
  return value;
}

function parseStringArray(value: unknown, label: string): string[] {
  try {
    const parsed: unknown = JSON.parse(requiredString(value, label));
    if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) {
      throw new Error();
    }
    return parsed;
  } catch {
    throw new Error(`${label}が不正です。`);
  }
}

function requiredString(value: unknown, label: string): string {
  const text = String(value ?? '').trim();
  if (!text) throw new Error(`${label}が空です。`);
  return text;
}

function optionalString(value: unknown): string {
  return String(value ?? '').trim();
}

function parseNonNegativeInteger(value: unknown, label: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`${label}が不正です。`);
  return number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
