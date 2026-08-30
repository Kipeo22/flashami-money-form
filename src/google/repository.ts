import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';

import { google } from 'googleapis';

import type { AppConfig } from '../config.js';
import { aggregateExpenses } from '../domain/settlement.js';
import type { CreateEventInput, EventRecord, Expense, Person } from '../domain/types.js';
import { createGoogleAuth } from './auth.js';

const SHEETS = {
  events: 'イベント',
  expenses: '支出',
  settlements: '精算',
  budget: '予算集計',
} as const;

const LEGACY_EXPENSE_HEADERS = [
  '支出ID',
  '登録日時',
  'サーバーID',
  'チャンネルID',
  '登録者ID',
  '登録者',
  '支払者ID',
  '支払者',
  '対象区分',
  '対象者ID(JSON)',
  '対象者名(JSON)',
  '対象者',
  '内容',
  '金額(円)',
  'レシートファイルID',
  'レシートURL',
  'レシート名',
] as const;

const EXPENSE_HEADERS = [...LEGACY_EXPENSE_HEADERS, 'イベントID', 'イベント名'] as const;
const EVENT_HEADERS = [
  'イベントID',
  'イベント名',
  '初期予算(円)',
  'DiscordサーバーID',
  'DiscordチャンネルID',
  '運営ロールID',
  'DriveフォルダID',
  '状態',
  '作成日時',
] as const;
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

type ReceiptUpload = {
  buffer: Buffer;
  filename: string;
  mimeType: string;
};

export class GoogleRepository {
  private readonly sheets;
  private readonly drive;
  private readonly spreadsheetId: string;
  private readonly rootDriveFolderId: string;

  constructor(config: AppConfig) {
    const auth = createGoogleAuth(config);
    this.sheets = google.sheets({ version: 'v4', auth });
    this.drive = google.drive({ version: 'v3', auth });
    this.spreadsheetId = config.google.spreadsheetId;
    this.rootDriveFolderId = config.google.driveFolderId;
  }

  async initialize(): Promise<void> {
    const spreadsheet = await this.sheets.spreadsheets.get({
      spreadsheetId: this.spreadsheetId,
      fields: 'sheets.properties.title',
    });
    const existing = new Set(
      spreadsheet.data.sheets
        ?.map((sheet) => sheet.properties?.title)
        .filter((title): title is string => Boolean(title)) ?? [],
    );
    const missing = Object.values(SHEETS).filter((title) => !existing.has(title));
    if (missing.length > 0) {
      await this.sheets.spreadsheets.batchUpdate({
        spreadsheetId: this.spreadsheetId,
        requestBody: {
          requests: missing.map((title) => ({ addSheet: { properties: { title } } })),
        },
      });
    }

    await this.ensureHeader(SHEETS.events, [...EVENT_HEADERS]);
    await this.ensureExpenseHeader();
    await this.ensureHeader(SHEETS.settlements, [...SETTLEMENT_HEADERS], true);
    await this.ensureHeader(SHEETS.budget, [...BUDGET_HEADERS], true);
    await this.refreshAggregations();
  }

  async listEvents(): Promise<EventRecord[]> {
    const response = await this.sheets.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range: range(SHEETS.events, 'A2:I'),
    });
    return (response.data.values ?? [])
      .filter((row) => row.some((value) => value !== ''))
      .map(rowToEvent)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
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
    const duplicate = (await this.listEvents()).find(
      (event) =>
        event.status === 'active' &&
        event.discordGuildId === input.discordGuildId &&
        event.discordChannelId === input.discordChannelId,
    );
    if (duplicate) {
      throw new EventConflictError(`このDiscordチャンネルは「${duplicate.name}」で使用中です。`);
    }

    const eventId = randomUUID();
    const folder = await this.drive.files.create({
      supportsAllDrives: true,
      requestBody: {
        name: `${input.name} (${eventId.slice(0, 8)})`,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [this.rootDriveFolderId],
      },
      fields: 'id',
    });
    if (!folder.data.id) throw new Error('イベント用Driveフォルダを作成できませんでした。');

    const event: EventRecord = {
      id: eventId,
      ...input,
      driveFolderId: folder.data.id,
      status: 'active',
      createdAt: new Date().toISOString(),
    };

    try {
      await this.sheets.spreadsheets.values.append({
        spreadsheetId: this.spreadsheetId,
        range: range(SHEETS.events, 'A:I'),
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: [eventToRow(event)] },
      });
      return event;
    } catch (error) {
      await this.deleteDriveItem(folder.data.id).catch(() => undefined);
      throw error;
    }
  }

  async hasExpense(expenseId: string): Promise<boolean> {
    const response = await this.sheets.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range: range(SHEETS.expenses, 'A2:A'),
    });
    return (response.data.values ?? []).some((row) => row[0] === expenseId);
  }

  async uploadReceipt(
    receipt: ReceiptUpload,
    eventFolderId: string,
  ): Promise<{ id: string; url: string }> {
    const response = await this.drive.files.create({
      supportsAllDrives: true,
      requestBody: { name: receipt.filename, parents: [eventFolderId] },
      media: { mimeType: receipt.mimeType, body: Readable.from(receipt.buffer) },
      fields: 'id,webViewLink',
    });
    const id = response.data.id;
    if (!id) throw new Error('Google DriveからファイルIDが返されませんでした。');
    return {
      id,
      url: response.data.webViewLink ?? `https://drive.google.com/open?id=${id}`,
    };
  }

  async deleteDriveItem(fileId: string): Promise<void> {
    await this.drive.files.delete({ fileId, supportsAllDrives: true });
  }

  async appendExpense(expense: Expense): Promise<void> {
    await this.sheets.spreadsheets.values.append({
      spreadsheetId: this.spreadsheetId,
      range: range(SHEETS.expenses, 'A:S'),
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [expenseToRow(expense)] },
    });
  }

  async refreshAggregations(): Promise<void> {
    const [expenses, events] = await Promise.all([this.readExpenses(), this.listEvents()]);
    const updatedAt = new Date().toISOString();
    const settlementRows: Array<Array<string | number>> = [];
    const budgetRows: Array<Array<string | number>> = [];

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

    await Promise.all([
      this.replaceSheetValues(SHEETS.settlements, [[...SETTLEMENT_HEADERS], ...settlementRows]),
      this.replaceSheetValues(SHEETS.budget, [[...BUDGET_HEADERS], ...budgetRows]),
    ]);
  }

  private async readExpenses(): Promise<Expense[]> {
    const response = await this.sheets.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range: range(SHEETS.expenses, 'A2:S'),
    });
    return (response.data.values ?? [])
      .filter((row) => row.some((value) => value !== '') && row[17] && row[18])
      .map(rowToExpense);
  }

  private async ensureExpenseHeader(): Promise<void> {
    const response = await this.sheets.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range: range(SHEETS.expenses, 'A1:S1'),
    });
    const current = response.data.values?.[0] ?? [];
    if (
      current.length === 0 ||
      JSON.stringify(current) === JSON.stringify(LEGACY_EXPENSE_HEADERS)
    ) {
      await this.writeHeader(SHEETS.expenses, [...EXPENSE_HEADERS]);
      return;
    }
    if (JSON.stringify(current) !== JSON.stringify(EXPENSE_HEADERS)) {
      throw new Error(`${SHEETS.expenses}シートの1行目が想定ヘッダーと異なります。`);
    }
  }

  private async ensureHeader(sheet: string, expected: string[], replaceExisting = false) {
    const response = await this.sheets.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range: range(sheet, `A1:${columnName(expected.length)}1`),
    });
    const current = response.data.values?.[0] ?? [];
    if (current.length === 0 || replaceExisting) {
      await this.writeHeader(sheet, expected);
      return;
    }
    if (JSON.stringify(current) !== JSON.stringify(expected)) {
      throw new Error(`${sheet}シートの1行目が想定ヘッダーと異なります。`);
    }
  }

  private async writeHeader(sheet: string, values: string[]): Promise<void> {
    await this.sheets.spreadsheets.values.update({
      spreadsheetId: this.spreadsheetId,
      range: range(sheet, `A1:${columnName(values.length)}1`),
      valueInputOption: 'RAW',
      requestBody: { values: [values] },
    });
  }

  private async replaceSheetValues(sheet: string, values: Array<Array<string | number>>) {
    await this.sheets.spreadsheets.values.clear({
      spreadsheetId: this.spreadsheetId,
      range: range(sheet, 'A:Z'),
    });
    await this.sheets.spreadsheets.values.update({
      spreadsheetId: this.spreadsheetId,
      range: range(sheet, 'A1'),
      valueInputOption: 'RAW',
      requestBody: { values },
    });
  }
}

export class EventConflictError extends Error {}

function eventToRow(event: EventRecord): Array<string | number> {
  return [
    event.id,
    event.name,
    event.initialBudgetYen,
    event.discordGuildId,
    event.discordChannelId,
    event.operationsRoleId,
    event.driveFolderId,
    event.status,
    event.createdAt,
  ];
}

function rowToEvent(row: unknown[]): EventRecord {
  const status = requiredString(row[7], '状態');
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
    status,
    createdAt: requiredString(row[8], '作成日時'),
  };
}

function expenseToRow(expense: Expense): Array<string | number> {
  const targetIds =
    expense.target.type === 'members' ? expense.target.members.map(({ id }) => id) : [];
  const targetNames =
    expense.target.type === 'members' ? expense.target.members.map(({ name }) => name) : ['運営'];
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
    targetNames.join('、'),
    expense.item,
    expense.amountYen,
    expense.receiptFileId,
    expense.receiptUrl,
    expense.receiptName,
    expense.event.id,
    expense.event.name,
  ];
}

function rowToExpense(row: unknown[]): Expense {
  const targetType = requiredString(row[8], '対象区分');
  const ids = parseStringArray(row[9], '対象者ID(JSON)');
  const names = parseStringArray(row[10], '対象者名(JSON)');
  if (ids.length !== names.length) {
    throw new Error('支出シートの対象者IDと名前の数が一致しません。');
  }
  const members: Person[] = ids.map((id, index) => ({ id, name: names[index] ?? id }));
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
    receiptFileId: requiredString(row[14], 'レシートファイルID'),
    receiptUrl: requiredString(row[15], 'レシートURL'),
    receiptName: requiredString(row[16], 'レシート名'),
  };
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

function parseNonNegativeInteger(value: unknown, label: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`${label}が不正です。`);
  return number;
}

function range(sheet: string, cells: string): string {
  return `'${sheet.replaceAll("'", "''")}'!${cells}`;
}

function columnName(count: number): string {
  let value = count;
  let result = '';
  while (value > 0) {
    value -= 1;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
}
