const SHEETS = Object.freeze({
  events: 'イベント',
  expenses: '支出',
  settlements: '精算',
  budget: '予算集計',
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
const MAX_RECEIPT_BYTES = 10 * 1024 * 1024;

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
      return hasExpense_(requiredString_(payload && payload.expenseId, '支出ID'));
    case 'uploadReceipt':
      return uploadReceipt_(requiredObject_(payload, 'レシート'));
    case 'deleteDriveItem':
      return deleteDriveItem_(requiredString_(payload && payload.fileId, 'ファイルID'));
    case 'appendExpense':
      return appendExpense_(payload && payload.row);
    case 'readExpenses':
      return readRows_(SHEETS.expenses, EXPENSE_HEADERS.length);
    case 'replaceAggregations':
      return replaceAggregations_(requiredObject_(payload, '集計'));
    default:
      throw new ApiError('UNKNOWN_ACTION', '未対応の処理です。');
  }
}

function initialize_() {
  const spreadsheet = getSpreadsheet_();
  Object.keys(SHEETS).forEach((key) => {
    const name = SHEETS[key];
    if (!spreadsheet.getSheetByName(name)) spreadsheet.insertSheet(name);
  });
  ensureHeader_(SHEETS.events, EVENT_HEADERS, false);
  ensureExpenseHeader_();
  ensureHeader_(SHEETS.settlements, SETTLEMENT_HEADERS, true);
  ensureHeader_(SHEETS.budget, BUDGET_HEADERS, true);
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
  const duplicate = readRows_(SHEETS.events, EVENT_HEADERS.length).find(
    (row) =>
      row[7] === 'active' &&
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
  const row = [
    eventId,
    name,
    initialBudgetYen,
    discordGuildId,
    discordChannelId,
    operationsRoleId,
    folder.getId(),
    'active',
    new Date().toISOString(),
  ];
  try {
    appendRow_(SHEETS.events, row);
    return row;
  } catch (error) {
    folder.setTrashed(true);
    throw error;
  }
}

function hasExpense_(expenseId) {
  return readRows_(SHEETS.expenses, 1).some((row) => String(row[0]) === expenseId);
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
    throw new ApiError('VALIDATION_ERROR', 'レシートは10 MiB以下にしてください。');
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
  if (hasExpense_(expenseId)) throw new ApiError('EXPENSE_CONFLICT', 'この支出は登録済みです。');
  requiredNonNegativeInteger_(row[13], '金額');
  appendRow_(SHEETS.expenses, row);
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
  replaceSheetValues_(SHEETS.settlements, settlementRows);
  replaceSheetValues_(SHEETS.budget, budgetRows);
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

function ensureExpenseHeader_() {
  const sheet = getSheet_(SHEETS.expenses);
  const current = trimTrailingBlanks_(
    sheet.getRange(1, 1, 1, EXPENSE_HEADERS.length).getDisplayValues()[0],
  );
  if (current.length === 0 || JSON.stringify(current) === JSON.stringify(LEGACY_EXPENSE_HEADERS)) {
    writeHeader_(sheet, EXPENSE_HEADERS);
    return;
  }
  if (JSON.stringify(current) !== JSON.stringify(EXPENSE_HEADERS)) {
    throw new ApiError(
      'HEADER_MISMATCH',
      `${SHEETS.expenses}シートの1行目が想定ヘッダーと異なります。`,
    );
  }
}

function ensureHeader_(sheetName, expected, replaceExisting) {
  const sheet = getSheet_(sheetName);
  const current = trimTrailingBlanks_(
    sheet.getRange(1, 1, 1, expected.length).getDisplayValues()[0],
  );
  if (current.length === 0 || replaceExisting) {
    writeHeader_(sheet, expected);
    return;
  }
  if (JSON.stringify(current) !== JSON.stringify(expected)) {
    throw new ApiError('HEADER_MISMATCH', `${sheetName}シートの1行目が想定ヘッダーと異なります。`);
  }
}

function writeHeader_(sheet, values) {
  sheet.getRange(1, 1, 1, values.length).setValues([values]);
}

function replaceSheetValues_(sheetName, values) {
  const sheet = getSheet_(sheetName);
  sheet.clearContents();
  if (values.length > 0) sheet.getRange(1, 1, values.length, values[0].length).setValues(values);
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
