import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

import type { Logger } from 'pino';

import type { AppConfig } from '../config.js';
import type { CreateEventInput, EventRecord, Expense } from '../domain/types.js';
import {
  EventConfigurationError,
  EventConflictError,
  ExpenseConflictError,
} from '../gas/repository.js';

type Flash = { type: 'success' | 'error'; message: string };

export type EventRepository = {
  listEvents(): Promise<EventRecord[]>;
  createEvent(input: CreateEventInput): Promise<EventRecord>;
  saveExpense(
    expense: Expense,
    eventFolderId: string,
    receipt: null,
  ): Promise<{ id: string; url: string } | null>;
  refreshAggregations(): Promise<void>;
};

export async function handleAdminRequest(
  request: Request,
  config: AppConfig,
  repository: EventRepository,
  logger: Pick<Logger, 'error'>,
): Promise<Response> {
  const csrfToken = createCsrfToken(config);
  const headers = securityHeaders();
  if (!isAuthorized(request, config.web.adminUsername, config.web.adminPassword)) {
    headers.set('WWW-Authenticate', 'Basic realm="Flashami Money", charset="UTF-8"');
    return textResponse('認証が必要です。', 401, headers);
  }

  const url = new URL(request.url);
  try {
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/api/admin')) {
      const events = await repository.listEvents();
      const flash = url.searchParams.has('aggregation-refreshed')
        ? { type: 'success' as const, message: '精算表と予算集計を再計算しました。' }
        : url.searchParams.has('created')
          ? url.searchParams.has('aggregation-warning')
            ? {
                type: 'error' as const,
                message:
                  'イベントは作成しましたが、集計表の更新に失敗しました。管理画面の「集計を再計算」を実行してください。',
              }
            : { type: 'success' as const, message: 'イベントを作成しました。' }
          : url.searchParams.has('expense-created')
            ? url.searchParams.has('aggregation-warning')
              ? {
                  type: 'error' as const,
                  message:
                    '事前支出は登録しましたが、予算集計の更新に失敗しました。管理画面の「集計を再計算」を実行してください。',
                }
              : { type: 'success' as const, message: '運営の事前支出を登録しました。' }
            : undefined;
      return htmlResponse(renderDashboard(events, config, csrfToken, flash), 200, headers);
    }

    if (
      request.method === 'POST' &&
      ['/events', '/expenses/operations', '/aggregations/refresh', '/api/admin'].includes(
        url.pathname,
      )
    ) {
      const form = new URLSearchParams(await readRequestBody(request));
      if (!safeEqual(form.get('_csrf') ?? '', csrfToken)) {
        return textResponse(
          'フォームの有効期限が切れました。ページを再読み込みしてください。',
          403,
          headers,
        );
      }
      const isAggregationRefresh =
        url.pathname === '/aggregations/refresh' || form.get('_action') === 'refresh-aggregations';
      if (isAggregationRefresh) {
        await repository.refreshAggregations();
        return redirectResponse('/?aggregation-refreshed=1', headers);
      }

      const isOperationsExpense =
        url.pathname === '/expenses/operations' ||
        form.get('_action') === 'create-operations-expense';
      if (isOperationsExpense) {
        const events = await repository.listEvents();
        const expense = parseOperationsExpenseForm(form, events);
        const event = events.find(({ id }) => id === expense.event.id);
        if (!event) throw new WebInputError('選択したイベントが見つかりません。');
        try {
          await repository.saveExpense(expense, event.driveFolderId, null);
        } catch (error) {
          if (!(error instanceof ExpenseConflictError)) throw error;
        }
        const aggregationWarning = await refreshAggregationsWithWarning(
          repository,
          logger,
          'aggregation refresh after operations expense failed',
        );
        return redirectResponse(
          aggregationWarning ? '/?expense-created=1&aggregation-warning=1' : '/?expense-created=1',
          headers,
        );
      }

      const input = parseEventForm(form, config);
      await repository.createEvent(input);
      const aggregationWarning = await refreshAggregationsWithWarning(
        repository,
        logger,
        'aggregation refresh after event creation failed',
      );
      return redirectResponse(
        aggregationWarning ? '/?created=1&aggregation-warning=1' : '/?created=1',
        headers,
      );
    }

    return textResponse('ページが見つかりません。', 404, headers);
  } catch (error) {
    logger.error({ err: error, path: url.pathname }, 'web request failed');
    const isInputError =
      error instanceof WebInputError ||
      error instanceof EventConflictError ||
      error instanceof EventConfigurationError;
    const message = isInputError
      ? error.message
      : '処理に失敗しました。GAS Webアプリの設定を確認してください。';
    const events = await repository.listEvents().catch(() => []);
    return htmlResponse(
      renderDashboard(events, config, csrfToken, { type: 'error', message }),
      isInputError ? 400 : 500,
      headers,
    );
  }
}

export function parseOperationsExpenseForm(form: URLSearchParams, events: EventRecord[]): Expense {
  const expenseId = (form.get('expenseId') ?? '').trim();
  if (
    !/^web-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(expenseId)
  ) {
    throw new WebInputError('フォームが正しくありません。ページを再読み込みしてください。');
  }

  const eventId = (form.get('eventId') ?? '').trim();
  const event = events.find(({ id, status }) => id === eventId && status === 'active');
  if (!event) throw new WebInputError('開催中のイベントを選択してください。');

  const item = (form.get('item') ?? '').trim();
  if (!item || item.length > 100) {
    throw new WebInputError('内容は1〜100文字で入力してください。');
  }

  const amountText = (form.get('amountYen') ?? '').normalize('NFKC').replace(/[\s,]/g, '');
  if (!/^\d+$/.test(amountText)) {
    throw new WebInputError('金額は1円以上の整数で入力してください。');
  }
  const amountYen = Number(amountText);
  if (!Number.isSafeInteger(amountYen) || amountYen < 1 || amountYen > 1_000_000_000) {
    throw new WebInputError('金額は1円以上10億円以下にしてください。');
  }

  const operations = { id: 'web-admin-operations', name: 'Flashami運営' };
  return {
    id: expenseId,
    event: { id: event.id, name: event.name },
    createdAt: new Date().toISOString(),
    guildId: event.discordGuildId,
    channelId: event.discordChannelId,
    submittedBy: operations,
    payer: operations,
    target: { type: 'operations' },
    item,
    amountYen,
    receiptFileId: '',
    receiptUrl: '',
    receiptName: '',
  };
}

export function parseEventForm(form: URLSearchParams, config: AppConfig): CreateEventInput {
  const name = (form.get('name') ?? '').trim();
  if (!name || name.length > 80) {
    throw new WebInputError('イベント名は1〜80文字で入力してください。');
  }

  const budgetText = (form.get('initialBudgetYen') ?? '').normalize('NFKC').replace(/[\s,]/g, '');
  if (!/^\d+$/.test(budgetText)) {
    throw new WebInputError('初期予算は0円以上の整数で入力してください。');
  }
  const initialBudgetYen = Number(budgetText);
  if (!Number.isSafeInteger(initialBudgetYen) || initialBudgetYen > 1_000_000_000) {
    throw new WebInputError('初期予算は10億円以下にしてください。');
  }

  const discordChannelId = parseSnowflake(form.get('discordChannelId'), 'DiscordチャンネルID');
  const operationsRoleId = parseSnowflake(form.get('operationsRoleId'), '運営ロールID');
  const spreadsheetId = parseSpreadsheetId(form.get('spreadsheet'));
  return {
    name,
    initialBudgetYen,
    discordGuildId: config.discord.guildId,
    discordChannelId,
    operationsRoleId,
    spreadsheetId,
  };
}

function parseSpreadsheetId(value: string | null): string {
  const text = (value ?? '').trim();
  const urlMatch = text.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  const id = urlMatch?.[1] ?? text;
  if (!/^[a-zA-Z0-9_-]{20,}$/.test(id)) {
    throw new WebInputError('イベントのGoogleスプレッドシートURLまたはIDが正しくありません。');
  }
  return id;
}

function parseSnowflake(value: string | null, label: string): string {
  const text = (value ?? '').trim();
  if (!/^\d{17,20}$/.test(text)) throw new WebInputError(`${label}が正しくありません。`);
  return text;
}

export function renderDashboard(
  events: EventRecord[],
  config: AppConfig,
  csrfToken: string,
  flash?: Flash,
): string {
  const activeEvents = events.filter((event) => event.status === 'active');
  const totalBudget = activeEvents.reduce((total, event) => total + event.initialBudgetYen, 0);
  const eventRows =
    events.length === 0
      ? `<div class="empty"><strong>イベントはまだありません</strong><p>「新しいイベントを作成」から最初の旅行イベントを登録してください。</p></div>`
      : `<div class="event-list">${events.map(renderEvent).join('')}</div>`;
  const activeEventOptions = activeEvents
    .map((event) => `<option value="${escapeHtml(event.id)}">${escapeHtml(event.name)}</option>`)
    .join('');

  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <title>Flashami Money｜管理ダッシュボード</title>
  <style>${styles}${dashboardStyles}</style>
</head>
<body>
  <main>
    <header>
      <div class="eyebrow">FLASHAMI MONEY</div>
      <h1>管理ダッシュボード</h1>
      <p>運営支出の登録、イベント管理、集計の確認をここで行います。</p>
    </header>
    ${flash ? `<div class="flash ${flash.type}" role="status">${escapeHtml(flash.message)}</div>` : ''}
    <section class="metrics" aria-label="イベント概要">
      <div><span>開催中</span><strong>${activeEvents.length}</strong><small>events</small></div>
      <div><span>登録済み</span><strong>${events.length}</strong><small>total</small></div>
      <div><span>開催中の予算</span><strong>¥${formatYen(totalBudget)}</strong><small>JPY</small></div>
    </section>
    <nav class="quick-nav" aria-label="管理メニュー">
      <a class="primary-nav" href="#operations-expense"><span>01</span><strong>運営支出を登録</strong><small>共通予算から支払った費用</small></a>
      <a href="#events"><span>02</span><strong>イベント一覧</strong><small>シートとレシートを確認</small></a>
      <a href="#new-event"><span>03</span><strong>新しいイベント</strong><small>旅行イベントを追加</small></a>
    </nav>
    <section id="operations-expense" class="panel task-panel operations-panel">
      <div class="section-heading">
        <div><span>よく使う操作</span><h2>運営支出を登録</h2><p>宿泊予約金など、運営が共通予算から事前に支払った費用を登録します。</p></div>
        <div class="budget-badge">個人間精算に含めない</div>
      </div>
      <form class="compact-form" method="post" action="/expenses/operations">
        <input type="hidden" name="_csrf" value="${csrfToken}">
        <input type="hidden" name="_action" value="create-operations-expense">
        <input type="hidden" name="expenseId" value="web-${randomUUID()}">
        <label>対象イベント<select name="eventId" required ${activeEvents.length === 0 ? 'disabled' : ''}><option value="">選択してください</option>${activeEventOptions}</select></label>
        <label>支出内容<input name="item" maxlength="100" placeholder="例：宿泊施設の予約金" required></label>
        <label>金額<input name="amountYen" inputmode="numeric" placeholder="例：30000" required><em>円</em></label>
        <button type="submit" ${activeEvents.length === 0 ? 'disabled' : ''}>支出を登録</button>
      </form>
      ${activeEvents.length === 0 ? '<p class="form-notice">先に開催中のイベントを作成してください。</p>' : ''}
    </section>
    <div class="management-grid">
      <section id="events" class="panel list-panel">
        <div class="section-heading">
          <div><span>イベント管理</span><h2>イベント一覧</h2><p>イベントごとのスプレッドシートとレシートを確認できます。</p></div>
          <form class="inline-action" method="post" action="/aggregations/refresh">
            <input type="hidden" name="_csrf" value="${csrfToken}">
            <input type="hidden" name="_action" value="refresh-aggregations">
            <button class="secondary-button" type="submit" ${events.length === 0 ? 'disabled' : ''}>集計を再計算</button>
          </form>
        </div>
        ${eventRows}
      </section>
      <section id="new-event" class="panel form-panel">
        <div class="section-heading"><div><span>初回・追加設定</span><h2>新しいイベントを作成</h2><p>旅行ごとに予算、Discordチャンネル、保存先シートを設定します。</p></div></div>
        <form method="post" action="/events">
          <input type="hidden" name="_csrf" value="${csrfToken}">
          <input type="hidden" name="_action" value="create-event">
          <label>イベント名<input name="name" maxlength="80" placeholder="例：夏合宿 2026" required></label>
          <label>初期予算<input name="initialBudgetYen" inputmode="numeric" value="${config.event.initialBudgetYen}" required><em>円</em></label>
          <label>DiscordチャンネルID<input name="discordChannelId" inputmode="numeric" pattern="[0-9]{17,20}" placeholder="123456789012345678" required></label>
          <label>イベントのGoogleスプレッドシート<input name="spreadsheet" placeholder="https://docs.google.com/spreadsheets/d/.../edit" required></label>
          <details class="advanced-settings">
            <summary><span>Discord詳細設定</span><small>通常は変更不要</small></summary>
            <div><label>運営ロールID<input name="operationsRoleId" inputmode="numeric" pattern="[0-9]{17,20}" value="${escapeHtml(config.discord.operationsRoleId)}" required></label><p class="hint">運営ロールを作り直した場合だけ変更してください。</p></div>
          </details>
          <p class="hint">既存スプレッドシートに「収支・精算」タブを追加します。既存のスケジュール・参加者タブは変更しません。</p>
          <button type="submit">イベントを作成</button>
        </form>
      </section>
    </div>
  </main>
</body>
</html>`;
}

function renderEvent(event: EventRecord): string {
  return `<article class="event-card">
    <div class="event-top"><div><span class="status ${event.status}">${event.status === 'active' ? '開催中' : '終了'}</span><h3>${escapeHtml(event.name)}</h3></div><strong>¥${formatYen(event.initialBudgetYen)}</strong></div>
    <dl><div><dt>Discord channel</dt><dd>${escapeHtml(event.discordChannelId)}</dd></div><div><dt>作成日</dt><dd>${formatDate(event.createdAt)}</dd></div></dl>
    <div><a href="https://docs.google.com/spreadsheets/d/${encodeURIComponent(event.spreadsheetId)}/edit" target="_blank" rel="noreferrer">収支・精算シートを開く ↗</a> · <a href="https://drive.google.com/drive/folders/${encodeURIComponent(event.driveFolderId)}" target="_blank" rel="noreferrer">レシートフォルダ ↗</a></div>
  </article>`;
}

const styles = `
:root{font-family:-apple-system,BlinkMacSystemFont,"Hiragino Sans","Yu Gothic UI",sans-serif;color:#18201b;background:#f2f3ec;font-synthesis:none}*{box-sizing:border-box}body{margin:0;min-height:100vh;background:radial-gradient(circle at 8% 0%,#fff 0,transparent 30%),#f2f3ec}main{width:min(1180px,calc(100% - 32px));margin:auto;padding:64px 0 80px}header{margin-bottom:32px}.eyebrow,.section-heading span{color:#63725f;font-size:12px;font-weight:750;letter-spacing:.16em}h1{font-size:clamp(36px,7vw,68px);letter-spacing:-.055em;line-height:1;margin:10px 0 14px}header p{color:#68706b;font-size:16px;margin:0}.metrics{display:grid;grid-template-columns:repeat(3,1fr);background:#1d2821;color:#fff;border-radius:22px;padding:8px;margin-bottom:20px}.metrics div{padding:22px 24px;border-right:1px solid #3c4940}.metrics div:last-child{border:0}.metrics span,.metrics small{display:block;color:#aeb8b0;font-size:12px}.metrics strong{display:inline-block;font-size:28px;margin:7px 6px 0 0}.metrics small{display:inline}.layout{display:grid;grid-template-columns:minmax(0,1.55fr) minmax(320px,.8fr);gap:20px;align-items:start}.panel{background:rgba(255,255,255,.82);border:1px solid #dfe2d9;border-radius:22px;padding:26px;box-shadow:0 18px 50px rgba(34,44,37,.06)}.section-heading{display:flex;justify-content:space-between;align-items:end;margin-bottom:22px}.section-heading h2{font-size:22px;margin:6px 0 0}.section-divider{height:1px;background:#e2e5dd;margin:30px 0}.event-list{display:grid;gap:12px}.event-card{border:1px solid #e2e5dd;border-radius:16px;padding:18px;background:#fff}.event-top{display:flex;justify-content:space-between;gap:16px;align-items:start}.event-top h3{font-size:18px;margin:8px 0 0}.event-top>strong{font-size:20px;white-space:nowrap}.status{display:inline-block;border-radius:100px;padding:4px 8px;background:#e3f1df;color:#37613b;font-size:11px;font-weight:700}.status.archived{background:#ececea;color:#6d706c}.event-card dl{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:20px 0}.event-card dl div{min-width:0}.event-card dt{color:#818781;font-size:11px}.event-card dd{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;overflow:hidden;text-overflow:ellipsis;margin:5px 0 0}.event-card a{color:#415c45;font-size:13px;font-weight:700;text-decoration:none}.empty{padding:56px 20px;text-align:center;color:#727a74;border:1px dashed #ccd1c8;border-radius:16px}.empty strong{color:#263029}.empty p{font-size:13px;margin:8px 0 0}form{display:grid;gap:17px}label{position:relative;display:grid;gap:7px;font-size:13px;font-weight:700}input,select{width:100%;border:1px solid #ccd2c9;background:#fff;border-radius:11px;padding:13px 14px;color:#18201b;font:inherit;outline:none}input:focus,select:focus{border-color:#526c56;box-shadow:0 0 0 3px rgba(82,108,86,.13)}label em{position:absolute;right:13px;bottom:13px;color:#7b827d;font-size:12px;font-style:normal}.hint{color:#737b75;font-size:12px;line-height:1.65;margin:0}button{border:0;border-radius:12px;background:#263a2c;color:#fff;padding:14px 18px;font:inherit;font-weight:750;cursor:pointer}button:hover{background:#19291e}button:disabled,select:disabled{cursor:not-allowed;opacity:.55}.flash{border-radius:12px;padding:13px 16px;margin-bottom:20px;font-size:14px}.flash.success{background:#e1f1df;color:#315536}.flash.error{background:#f8e3df;color:#7a342a}@media(max-width:800px){main{padding-top:38px}.layout{grid-template-columns:1fr}.form-panel{grid-row:1}.metrics{grid-template-columns:1fr}.metrics div{border-right:0;border-bottom:1px solid #3c4940}.event-card dl{grid-template-columns:1fr}}`;

const dashboardStyles = `
html{scroll-behavior:smooth}header{margin-bottom:28px}header p{max-width:620px;line-height:1.7}.quick-nav{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:0 0 20px}.quick-nav a{display:grid;grid-template-columns:auto 1fr;column-gap:12px;align-items:center;border:1px solid #dfe3da;border-radius:16px;padding:17px 18px;background:rgba(255,255,255,.72);color:#1d2821;text-decoration:none;transition:transform .15s ease,border-color .15s ease,background .15s ease}.quick-nav a:hover{transform:translateY(-2px);border-color:#b5c1b3;background:#fff}.quick-nav a>span{grid-row:1/3;color:#8b958d;font:700 12px ui-monospace,SFMono-Regular,Menlo,monospace}.quick-nav strong{font-size:14px}.quick-nav small{color:#7b837d;font-size:11px;margin-top:3px}.quick-nav .primary-nav{background:#263a2c;border-color:#263a2c;color:#fff}.quick-nav .primary-nav span,.quick-nav .primary-nav small{color:#b8c5ba}.task-panel{margin-bottom:20px}.operations-panel{background:linear-gradient(135deg,#f7fbf4,#fff);border-color:#cddbc9}.section-heading{align-items:flex-start}.section-heading p{color:#737b75;font-size:12px;line-height:1.6;margin:8px 0 0;max-width:560px}.budget-badge{border-radius:100px;background:#e3f1df;color:#37613b;font-size:11px;font-weight:700;padding:7px 10px;white-space:nowrap}.compact-form{grid-template-columns:1.1fr 1.5fr .8fr auto;align-items:end}.compact-form button{min-height:47px;white-space:nowrap}.form-notice{color:#8a5b32;background:#fff5e8;border-radius:10px;padding:10px 12px;font-size:12px;margin:14px 0 0}.management-grid{display:grid;grid-template-columns:minmax(0,1.45fr) minmax(330px,.75fr);gap:20px;align-items:start}.inline-action{display:block}.secondary-button{border:1px solid #cbd2c8;background:#fff;color:#34483a;padding:10px 14px;font-size:13px}.secondary-button:hover{background:#f3f5f0}.advanced-settings{border:1px solid #dde2da;border-radius:12px;background:#f8f9f6}.advanced-settings summary{display:flex;justify-content:space-between;align-items:center;padding:13px 14px;cursor:pointer;font-size:13px;font-weight:700}.advanced-settings summary small{color:#7d857f;font-size:11px;font-weight:500}.advanced-settings>div{display:grid;gap:10px;border-top:1px solid #e1e5de;padding:14px}.form-panel{position:sticky;top:20px}@media(max-width:900px){.compact-form{grid-template-columns:1fr 1fr}.compact-form button{grid-column:1/-1}.management-grid{grid-template-columns:1fr}.form-panel{position:static;grid-row:auto}.quick-nav{grid-template-columns:1fr}.quick-nav a{padding:14px 16px}}@media(max-width:600px){.compact-form{grid-template-columns:1fr}.compact-form button{grid-column:auto}.section-heading{gap:14px}.budget-badge{display:none}.secondary-button{padding:9px 10px}.panel{padding:21px}}
`;

async function readRequestBody(request: Request): Promise<string> {
  const body = await request.text();
  if (Buffer.byteLength(body) > 32 * 1024) throw new WebInputError('入力内容が大きすぎます。');
  return body;
}

function isAuthorized(request: Request, username: string, password: string): boolean {
  const authorization = request.headers.get('authorization');
  if (!authorization?.startsWith('Basic ')) return false;
  try {
    const decoded = Buffer.from(authorization.slice(6), 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    if (separator < 0) return false;
    return (
      safeEqual(decoded.slice(0, separator), username) &&
      safeEqual(decoded.slice(separator + 1), password)
    );
  } catch {
    return false;
  }
}

function safeEqual(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return (
    actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

function createCsrfToken(config: AppConfig): string {
  return createHmac('sha256', config.gas.sharedSecret)
    .update(`admin-form-v1:${config.web.adminUsername}`)
    .digest('base64url');
}

function securityHeaders(): Headers {
  return new Headers({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy':
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    'Cache-Control': 'no-store',
  });
}

function htmlResponse(html: string, status: number, headers: Headers): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set('Content-Type', 'text/html; charset=utf-8');
  return new Response(html, { status, headers: responseHeaders });
}

async function refreshAggregationsWithWarning(
  repository: EventRepository,
  logger: Pick<Logger, 'error'>,
  logMessage: string,
): Promise<boolean> {
  try {
    await repository.refreshAggregations();
    return false;
  } catch (error) {
    logger.error({ err: error }, logMessage);
    return true;
  }
}

function redirectResponse(location: string, headers: Headers): Response {
  return new Response(null, {
    status: 303,
    headers: { ...Object.fromEntries(headers), Location: location },
  });
}

function textResponse(text: string, status: number, headers: Headers): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set('Content-Type', 'text/plain; charset=utf-8');
  return new Response(text, { status, headers: responseHeaders });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return entities[character] ?? character;
  });
}

function formatYen(value: number): string {
  return value.toLocaleString('ja-JP');
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('ja-JP', { dateStyle: 'medium' }).format(new Date(value));
}

class WebInputError extends Error {}
