const SHEETS = Object.freeze({
  events: 'イベント',
  expenses: '支出',
});

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
];
const EXPENSE_HEADERS = LEGACY_EXPENSE_HEADERS.concat(['イベントID', 'イベント名']);
const LEGACY_EVENT_HEADERS = [
  'イベントID',
  'イベント名',
  '初期予算(円)',
  'DiscordサーバーID',
  'DiscordチャンネルID',
  '運営ロールID',
  'DriveフォルダID',
  '状態',
  '作成日時',
];
const EVENT_HEADERS = [
  'イベントID',
  'イベント名',
  '初期予算(円)',
  'DiscordサーバーID',
  'DiscordチャンネルID',
  '運営ロールID',
  'DriveフォルダID',
  'イベントスプレッドシートID',
  '状態',
  '作成日時',
];
const SETTLEMENT_HEADERS = [
  'イベントID',
  'イベント名',
  '支払元ID',
  '支払元',
  '支払先ID',
  '支払先',
  '金額(円)',
  '更新日時',
];
const BUDGET_HEADERS = [
  'イベントID',
  'イベント名',
  '初期予算(円)',
  '使用額(円)',
  '残額(円)',
  '更新日時',
];

const MAX_CLOCK_SKEW_SECONDS = 300;
const MAX_RECEIPT_BYTES = 20 * 1000 * 1000;
const EVENT_SHEET_NAME = '収支・精算';
const EXPENSE_HEADER_ROW = 8;
const EXPENSE_FIRST_ROW = 9;
const SETTLEMENT_FIRST_COLUMN = 21;

// GASエディタから最初に1回実行し、権限承認とシート初期化を行います。
function setup() {
  return initialize_();
}

function doPost(event) {
  const lock = LockService.getScriptLock();
  try {
    const request = authenticateRequest_(event);
    if (!lock.tryLock(10 * 1000)) {
      throw new ApiError('BUSY', 'ほかの処理を実行中です。少し待って再試行してください。');
    }
    return jsonResponse_({ ok: true, data: dispatch_(request.action, request.payload) });
  } catch (error) {
    console.error(error && error.stack ? error.stack : error);
    return jsonResponse_({
      ok: false,
      error: {
        code: error instanceof ApiError ? error.code : 'INTERNAL_ERROR',
        message: error instanceof ApiError ? error.message : 'GASで処理に失敗しました。',
      },
    });
  } finally {
    if (lock.hasLock()) lock.releaseLock();
  }
}

function authenticateRequest_(event) {
  const properties = PropertiesService.getScriptProperties();
  const secret = properties.getProperty('SHARED_SECRET');
  if (!secret || secret.length < 32) {
    throw new ApiError('CONFIG_ERROR', 'SHARED_SECRETが設定されていません。');
  }

  let envelope;
  try {
    envelope = JSON.parse(event && event.postData ? event.postData.contents : '');
  } catch (_error) {
    throw new ApiError('BAD_REQUEST', 'JSONリクエストが不正です。');
  }
  if (!envelope || typeof envelope.body !== 'string' || typeof envelope.signature !== 'string') {
    throw new ApiError('BAD_REQUEST', '署名付きリクエストが必要です。');
  }

  const expectedSignature = Utilities.base64EncodeWebSafe(
    Utilities.computeHmacSha256Signature(envelope.body, secret, Utilities.Charset.UTF_8),
  ).replace(/=+$/, '');
  if (!constantTimeEqual_(expectedSignature, envelope.signature)) {
    throw new ApiError('UNAUTHORIZED', 'リクエスト署名が一致しません。');
  }

  let request;
  try {
    request = JSON.parse(envelope.body);
  } catch (_error) {
    throw new ApiError('BAD_REQUEST', '署名対象のJSONが不正です。');
  }
  if (
    !request ||
    request.version !== 1 ||
    !Number.isInteger(request.timestamp) ||
    typeof request.nonce !== 'string' ||
    request.nonce.length < 16 ||
    typeof request.action !== 'string'
  ) {
    throw new ApiError('BAD_REQUEST', 'リクエスト形式が不正です。');
  }
  const currentTimestamp = Math.floor(Date.now() / 1000);
  if (Math.abs(currentTimestamp - request.timestamp) > MAX_CLOCK_SKEW_SECONDS) {
    throw new ApiError('EXPIRED_REQUEST', 'リクエストの有効期限が切れています。');
  }

  const cache = CacheService.getScriptCache();
  const nonceKey = `nonce:${request.nonce}`;
  if (cache.get(nonceKey))
    throw new ApiError('REPLAYED_REQUEST', '同じリクエストは再利用できません。');
  cache.put(nonceKey, '1', MAX_CLOCK_SKEW_SECONDS * 2);
  return request;
}

function dispatch_(action, payload) {
  switch (action) {
    case 'initialize':
      return initialize_();
    case 'listEvents':
      return readRows_(SHEETS.events, EVENT_HEADERS.length);
    case 'createEvent':
      return createEvent_(requiredObject_(payload, 'イベント'));
    case 'hasExpense':
      return hasExpense_(
        requiredString_(payload && payload.expenseId, '支出ID'),
        requiredString_(payload && payload.eventId, 'イベントID'),
      );
    case 'uploadReceipt':
      return uploadReceipt_(requiredObject_(payload, 'レシート'));
    case 'deleteDriveItem':
      return deleteDriveItem_(requiredString_(payload && payload.fileId, 'ファイルID'));
    case 'appendExpense':
      return appendExpense_(payload && payload.row);
    case 'readExpenses':
      return readAllEventExpenses_();
    case 'replaceAggregations':
      return replaceAggregations_(requiredObject_(payload, '集計'));
    default:
      throw new ApiError('UNKNOWN_ACTION', '未対応の処理です。');
  }
}

function initialize_() {
  const spreadsheet = getSpreadsheet_();
  if (!spreadsheet.getSheetByName(SHEETS.events)) spreadsheet.insertSheet(SHEETS.events);
  ensureEventHeader_();
  migrateLegacyEvents_();
  SpreadsheetApp.flush();
  return null;
}

function createEvent_(input) {
  const name = requiredString_(input.name, 'イベント名');
  if (name.length > 80) throw new ApiError('VALIDATION_ERROR', 'イベント名が長すぎます。');
  const initialBudgetYen = requiredNonNegativeInteger_(input.initialBudgetYen, '初期予算');
  const discordGuildId = requiredSnowflake_(input.discordGuildId, 'DiscordサーバーID');
  const discordChannelId = requiredSnowflake_(input.discordChannelId, 'DiscordチャンネルID');
  const operationsRoleId = requiredSnowflake_(input.operationsRoleId, '運営ロールID');
  const spreadsheetId = requiredSpreadsheetId_(input.spreadsheetId);
  const duplicate = readRows_(SHEETS.events, EVENT_HEADERS.length).find(
    (row) =>
      row[8] === 'active' &&
      String(row[3]) === discordGuildId &&
      String(row[4]) === discordChannelId,
  );
  if (duplicate) {
    throw new ApiError(
      'EVENT_CONFLICT',
      `このDiscordチャンネルは「${duplicate[1]}」で使用中です。`,
    );
  }

  const rootFolderId = requiredProperty_('DRIVE_FOLDER_ID');
  const eventId = Utilities.getUuid();
  const folder = DriveApp.getFolderById(rootFolderId).createFolder(
    `${name} (${eventId.slice(0, 8)})`.slice(0, 200),
  );
  try {
    const eventSpreadsheet = prepareEventSpreadsheet_(
      spreadsheetId,
      { id: eventId, name, initialBudgetYen },
      [],
    );
    const row = [
      eventId,
      name,
      initialBudgetYen,
      discordGuildId,
      discordChannelId,
      operationsRoleId,
      folder.getId(),
      eventSpreadsheet.getId(),
      'active',
      new Date().toISOString(),
    ];
    appendRow_(SHEETS.events, row);
    return row;
  } catch (error) {
    folder.setTrashed(true);
    throw error;
  }
}

function hasExpense_(expenseId, eventId) {
  const eventRow = findEventRow_(eventId);
  return readEventExpenses_(eventRow).some((row) => String(row[0]) === expenseId);
}

function uploadReceipt_(payload) {
  const eventFolderId = requiredString_(payload.eventFolderId, 'イベントフォルダID');
  const filename = requiredString_(payload.filename, 'ファイル名');
  const mimeType = requiredString_(payload.mimeType, 'MIMEタイプ');
  const base64 = requiredString_(payload.base64, 'ファイルデータ');
  if (filename.length > 200) throw new ApiError('VALIDATION_ERROR', 'ファイル名が長すぎます。');
  if (!(mimeType.indexOf('image/') === 0 || mimeType === 'application/pdf')) {
    throw new ApiError('VALIDATION_ERROR', 'レシートは画像またはPDFにしてください。');
  }

  let bytes;
  try {
    bytes = Utilities.base64Decode(base64);
  } catch (_error) {
    throw new ApiError('VALIDATION_ERROR', 'レシートデータが不正です。');
  }
  if (bytes.length > MAX_RECEIPT_BYTES) {
    throw new ApiError(
      'VALIDATION_ERROR',
      `レシートは20 MB以下にしてください（GAS検出: ${(bytes.length / (1024 * 1024)).toFixed(2)} MiB）。`,
    );
  }
  const blob = Utilities.newBlob(bytes, mimeType, filename);
  const file = DriveApp.getFolderById(eventFolderId).createFile(blob);
  return { id: file.getId(), url: file.getUrl() };
}

function deleteDriveItem_(fileId) {
  DriveApp.getFileById(fileId).setTrashed(true);
  return null;
}

function appendExpense_(row) {
  if (!Array.isArray(row) || row.length !== EXPENSE_HEADERS.length) {
    throw new ApiError('VALIDATION_ERROR', '支出データの列数が不正です。');
  }
  const expenseId = requiredString_(row[0], '支出ID');
  const eventId = requiredString_(row[17], 'イベントID');
  if (hasExpense_(expenseId, eventId)) {
    throw new ApiError('EXPENSE_CONFLICT', 'この支出は登録済みです。');
  }
  requiredNonNegativeInteger_(row[13], '金額');
  appendEventExpense_(findEventRow_(eventId), row);
  return null;
}

function replaceAggregations_(payload) {
  const settlementRows = requiredMatrix_(payload.settlementRows, '精算データ');
  const budgetRows = requiredMatrix_(payload.budgetRows, '予算集計データ');
  if (JSON.stringify(settlementRows[0]) !== JSON.stringify(SETTLEMENT_HEADERS)) {
    throw new ApiError('VALIDATION_ERROR', '精算ヘッダーが不正です。');
  }
  if (JSON.stringify(budgetRows[0]) !== JSON.stringify(BUDGET_HEADERS)) {
    throw new ApiError('VALIDATION_ERROR', '予算集計ヘッダーが不正です。');
  }
  const settlementsByEvent = {};
  settlementRows.slice(1).forEach((row) => {
    const eventId = requiredString_(row[0], '精算イベントID');
    if (!settlementsByEvent[eventId]) settlementsByEvent[eventId] = [];
    settlementsByEvent[eventId].push(row);
  });
  const budgetsByEvent = {};
  budgetRows.slice(1).forEach((row) => {
    budgetsByEvent[requiredString_(row[0], '予算イベントID')] = row;
  });
  readRows_(SHEETS.events, EVENT_HEADERS.length).forEach((eventRow) => {
    updateEventAggregation_(
      eventRow,
      settlementsByEvent[String(eventRow[0])] || [],
      budgetsByEvent[String(eventRow[0])],
    );
  });
  SpreadsheetApp.flush();
  return null;
}

function getSpreadsheet_() {
  return SpreadsheetApp.openById(requiredProperty_('SPREADSHEET_ID'));
}

function getSheet_(name) {
  const sheet = getSpreadsheet_().getSheetByName(name);
  if (!sheet) throw new ApiError('CONFIG_ERROR', `${name}シートがありません。初期化してください。`);
  return sheet;
}

function readRows_(sheetName, columnCount) {
  const sheet = getSheet_(sheetName);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  return sheet.getRange(2, 1, lastRow - 1, columnCount).getValues();
}

function appendRow_(sheetName, row) {
  const sheet = getSheet_(sheetName);
  sheet.getRange(sheet.getLastRow() + 1, 1, 1, row.length).setValues([row]);
  SpreadsheetApp.flush();
}

function ensureEventHeader_() {
  const sheet = getSheet_(SHEETS.events);
  const current = trimTrailingBlanks_(
    sheet.getRange(1, 1, 1, EVENT_HEADERS.length).getDisplayValues()[0],
  );
  if (current.length === 0) {
    writeHeader_(sheet, EVENT_HEADERS);
    return;
  }
  if (JSON.stringify(current) === JSON.stringify(LEGACY_EVENT_HEADERS)) {
    sheet.insertColumnAfter(7);
    writeHeader_(sheet, EVENT_HEADERS);
    return;
  }
  if (JSON.stringify(current) !== JSON.stringify(EVENT_HEADERS)) {
    throw new ApiError(
      'HEADER_MISMATCH',
      `${SHEETS.events}シートの1行目が想定ヘッダーと異なります。`,
    );
  }
}

function writeHeader_(sheet, values) {
  sheet.getRange(1, 1, 1, values.length).setValues([values]);
}

function migrateLegacyEvents_() {
  const legacyExpenses = readLegacyExpenseRows_();
  const events = readRows_(SHEETS.events, EVENT_HEADERS.length);
  events.forEach((eventRow) => {
    const eventId = requiredString_(eventRow[0], 'イベントID');
    const spreadsheetId = String(eventRow[7] || '').trim();
    if (!spreadsheetId) {
      throw new ApiError(
        'MIGRATION_REQUIRED',
        `「${eventRow[1]}」の既存スプレッドシートIDを、イベントシートの「イベントスプレッドシートID」列へ入力してください。`,
      );
    }
    prepareEventSpreadsheet_(
      requiredSpreadsheetId_(spreadsheetId),
      {
        id: eventId,
        name: requiredString_(eventRow[1], 'イベント名'),
        initialBudgetYen: requiredNonNegativeInteger_(eventRow[2], '初期予算'),
      },
      legacyExpenses.filter((expenseRow) => String(expenseRow[17]) === eventId),
    );
  });
}

function readLegacyExpenseRows_() {
  const sheet = getSpreadsheet_().getSheetByName(SHEETS.expenses);
  if (!sheet || sheet.getLastRow() < 2) return [];
  return sheet
    .getRange(2, 1, sheet.getLastRow() - 1, EXPENSE_HEADERS.length)
    .getValues()
    .filter((row) => row.some((value) => value !== ''));
}

function prepareEventSpreadsheet_(spreadsheetId, event, expenseRows) {
  let spreadsheet;
  try {
    spreadsheet = SpreadsheetApp.openById(spreadsheetId);
  } catch (_error) {
    throw new ApiError(
      'SPREADSHEET_ACCESS',
      '指定したイベントスプレッドシートを開けません。IDとGAS所有者の編集権限を確認してください。',
    );
  }
  let sheet = spreadsheet.getSheetByName(EVENT_SHEET_NAME);
  const isNewSheet = !sheet;
  if (!sheet) sheet = spreadsheet.insertSheet(EVENT_SHEET_NAME);
  const shouldInitialize = isNewSheet || sheet.getLastRow() === 0;
  ensureSheetSize_(sheet, Math.max(1000, EXPENSE_FIRST_ROW + expenseRows.length), 28);
  if (!shouldInitialize && !isManagedEventSheet_(sheet)) {
    throw new ApiError(
      'SHEET_CONFLICT',
      `既存の「${EVENT_SHEET_NAME}」タブはBotの想定形式ではありません。名前を変更してから再試行してください。`,
    );
  }
  if (shouldInitialize) {
    sheet.getRange(1, 1, 5, 2).setValues([
      ['イベント名', event.name],
      ['初期予算(円)', event.initialBudgetYen],
      ['共通予算使用額(円)', 0],
      ['共通予算残額(円)', event.initialBudgetYen],
      ['更新日時', new Date().toISOString()],
    ]);
    sheet.getRange(7, 1, 1, EXPENSE_HEADERS.length).merge().setValue('収支記録');
    sheet
      .getRange(7, SETTLEMENT_FIRST_COLUMN, 1, SETTLEMENT_HEADERS.length)
      .merge()
      .setValue('精算結果');
    sheet.getRange(EXPENSE_HEADER_ROW, 1, 1, EXPENSE_HEADERS.length).setValues([EXPENSE_HEADERS]);
    sheet
      .getRange(EXPENSE_HEADER_ROW, SETTLEMENT_FIRST_COLUMN, 1, SETTLEMENT_HEADERS.length)
      .setValues([SETTLEMENT_HEADERS]);
    formatEventSheet_(sheet);
  }
  sheet.getRange(1, 2).setValue(event.name);
  sheet.getRange(2, 2).setValue(event.initialBudgetYen);
  appendMissingLegacyExpenses_(sheet, expenseRows);
  SpreadsheetApp.flush();
  return spreadsheet;
}

function isManagedEventSheet_(sheet) {
  if (sheet.getLastRow() === 0) return true;
  const expenseHeaders = sheet
    .getRange(EXPENSE_HEADER_ROW, 1, 1, EXPENSE_HEADERS.length)
    .getDisplayValues()[0];
  const settlementHeaders = sheet
    .getRange(EXPENSE_HEADER_ROW, SETTLEMENT_FIRST_COLUMN, 1, SETTLEMENT_HEADERS.length)
    .getDisplayValues()[0];
  return (
    JSON.stringify(expenseHeaders) === JSON.stringify(EXPENSE_HEADERS) &&
    JSON.stringify(settlementHeaders) === JSON.stringify(SETTLEMENT_HEADERS)
  );
}

function appendMissingLegacyExpenses_(sheet, expenseRows) {
  if (expenseRows.length === 0) return;
  const existingIds = new Set(
    readExpenseRowsFromSheet_(sheet).map((row) => requiredString_(row[0], '支出ID')),
  );
  const missingRows = expenseRows.filter((row) => !existingIds.has(String(row[0])));
  missingRows.forEach((row) => appendExpenseRowToSheet_(sheet, row));
}

function formatEventSheet_(sheet) {
  sheet.setFrozenRows(EXPENSE_HEADER_ROW);
  sheet.getRange(1, 1, 5, 1).setFontWeight('bold');
  sheet.getRange(2, 2, 3, 1).setNumberFormat('#,##0');
  sheet.getRange(7, 1, 1, EXPENSE_HEADERS.length).setFontWeight('bold').setBackground('#dfe9df');
  sheet
    .getRange(7, SETTLEMENT_FIRST_COLUMN, 1, SETTLEMENT_HEADERS.length)
    .setFontWeight('bold')
    .setBackground('#dfe9df');
  sheet
    .getRange(EXPENSE_HEADER_ROW, 1, 1, EXPENSE_HEADERS.length)
    .setFontWeight('bold')
    .setBackground('#263a2c')
    .setFontColor('#ffffff');
  sheet
    .getRange(EXPENSE_HEADER_ROW, SETTLEMENT_FIRST_COLUMN, 1, SETTLEMENT_HEADERS.length)
    .setFontWeight('bold')
    .setBackground('#263a2c')
    .setFontColor('#ffffff');
  sheet.autoResizeColumns(1, EXPENSE_HEADERS.length);
  sheet.autoResizeColumns(SETTLEMENT_FIRST_COLUMN, SETTLEMENT_HEADERS.length);
}

function findEventRow_(eventId) {
  const eventRow = readRows_(SHEETS.events, EVENT_HEADERS.length).find(
    (row) => String(row[0]) === eventId,
  );
  if (!eventRow) throw new ApiError('NOT_FOUND', 'イベントが見つかりません。');
  requiredString_(eventRow[7], 'イベントスプレッドシートID');
  return eventRow;
}

function getEventSheet_(eventRow) {
  const spreadsheet = SpreadsheetApp.openById(
    requiredString_(eventRow[7], 'イベントスプレッドシートID'),
  );
  const sheet = spreadsheet.getSheetByName(EVENT_SHEET_NAME);
  if (!sheet) throw new ApiError('CONFIG_ERROR', `${EVENT_SHEET_NAME}シートがありません。`);
  return sheet;
}

function readEventExpenses_(eventRow) {
  return readExpenseRowsFromSheet_(getEventSheet_(eventRow));
}

function readExpenseRowsFromSheet_(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < EXPENSE_FIRST_ROW) return [];
  return sheet
    .getRange(EXPENSE_FIRST_ROW, 1, lastRow - EXPENSE_FIRST_ROW + 1, EXPENSE_HEADERS.length)
    .getValues()
    .filter((row) => String(row[0] || '').trim());
}

function readAllEventExpenses_() {
  const rows = [];
  readRows_(SHEETS.events, EVENT_HEADERS.length).forEach((eventRow) => {
    rows.push.apply(rows, readEventExpenses_(eventRow));
  });
  return rows;
}

function appendEventExpense_(eventRow, row) {
  appendExpenseRowToSheet_(getEventSheet_(eventRow), row);
  SpreadsheetApp.flush();
}

function appendExpenseRowToSheet_(sheet, row) {
  const candidateCount = Math.max(sheet.getLastRow() - EXPENSE_FIRST_ROW + 1, 1);
  const firstColumn = sheet.getRange(EXPENSE_FIRST_ROW, 1, candidateCount, 1).getValues();
  let nextRow = EXPENSE_FIRST_ROW;
  for (let index = firstColumn.length - 1; index >= 0; index -= 1) {
    if (String(firstColumn[index][0] || '').trim()) {
      nextRow = EXPENSE_FIRST_ROW + index + 1;
      break;
    }
  }
  ensureSheetSize_(sheet, nextRow, EXPENSE_HEADERS.length);
  sheet.getRange(nextRow, 1, 1, EXPENSE_HEADERS.length).setValues([row]);
}

function updateEventAggregation_(eventRow, settlementRows, budgetRow) {
  const sheet = getEventSheet_(eventRow);
  const initialBudgetYen = requiredNonNegativeInteger_(eventRow[2], '初期予算');
  const spentYen = budgetRow ? requiredNonNegativeInteger_(budgetRow[3], '使用額') : 0;
  const remainingYen = budgetRow ? Number(budgetRow[4]) : initialBudgetYen - spentYen;
  const updatedAt = budgetRow
    ? requiredString_(budgetRow[5], '更新日時')
    : new Date().toISOString();
  sheet
    .getRange(1, 2, 5, 1)
    .setValues([
      [requiredString_(eventRow[1], 'イベント名')],
      [initialBudgetYen],
      [spentYen],
      [remainingYen],
      [updatedAt],
    ]);
  const clearRows = Math.max(sheet.getMaxRows() - EXPENSE_HEADER_ROW + 1, 1);
  sheet
    .getRange(EXPENSE_HEADER_ROW, SETTLEMENT_FIRST_COLUMN, clearRows, SETTLEMENT_HEADERS.length)
    .clearContent();
  ensureSheetSize_(sheet, EXPENSE_HEADER_ROW + settlementRows.length, 28);
  sheet
    .getRange(EXPENSE_HEADER_ROW, SETTLEMENT_FIRST_COLUMN, 1, SETTLEMENT_HEADERS.length)
    .setValues([SETTLEMENT_HEADERS]);
  if (settlementRows.length > 0) {
    sheet
      .getRange(
        EXPENSE_FIRST_ROW,
        SETTLEMENT_FIRST_COLUMN,
        settlementRows.length,
        SETTLEMENT_HEADERS.length,
      )
      .setValues(settlementRows);
  }
  sheet.getRange(2, 2, 3, 1).setNumberFormat('#,##0');
}

function ensureSheetSize_(sheet, requiredRows, requiredColumns) {
  if (sheet.getMaxRows() < requiredRows) {
    sheet.insertRowsAfter(sheet.getMaxRows(), requiredRows - sheet.getMaxRows());
  }
  if (sheet.getMaxColumns() < requiredColumns) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), requiredColumns - sheet.getMaxColumns());
  }
}

function requiredProperty_(name) {
  const value = PropertiesService.getScriptProperties().getProperty(name);
  if (!value) throw new ApiError('CONFIG_ERROR', `${name}がスクリプトプロパティにありません。`);
  return value;
}

function requiredObject_(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ApiError('VALIDATION_ERROR', `${label}が不正です。`);
  }
  return value;
}

function requiredMatrix_(value, label) {
  if (!Array.isArray(value) || value.length === 0 || !value.every(Array.isArray)) {
    throw new ApiError('VALIDATION_ERROR', `${label}が不正です。`);
  }
  const width = value[0].length;
  if (width === 0 || !value.every((row) => row.length === width)) {
    throw new ApiError('VALIDATION_ERROR', `${label}の列数が一致しません。`);
  }
  return value;
}

function requiredString_(value, label) {
  const text = String(value == null ? '' : value).trim();
  if (!text) throw new ApiError('VALIDATION_ERROR', `${label}が空です。`);
  return text;
}

function requiredSnowflake_(value, label) {
  const text = requiredString_(value, label);
  if (!/^\d{17,20}$/.test(text)) throw new ApiError('VALIDATION_ERROR', `${label}が不正です。`);
  return text;
}

function requiredSpreadsheetId_(value) {
  const text = requiredString_(value, 'イベントスプレッドシートID');
  if (!/^[a-zA-Z0-9_-]{20,}$/.test(text)) {
    throw new ApiError('VALIDATION_ERROR', 'イベントスプレッドシートIDが不正です。');
  }
  return text;
}

function requiredNonNegativeInteger_(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new ApiError('VALIDATION_ERROR', `${label}が不正です。`);
  }
  return number;
}

function trimTrailingBlanks_(values) {
  const result = values.slice();
  while (result.length > 0 && result[result.length - 1] === '') result.pop();
  return result;
}

function constantTimeEqual_(actual, expected) {
  if (actual.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < actual.length; index += 1) {
    difference |= actual.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return difference === 0;
}

function jsonResponse_(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(
    ContentService.MimeType.JSON,
  );
}

class ApiError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
