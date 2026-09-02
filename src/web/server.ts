import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import type { Logger } from 'pino';

import type { AppConfig } from '../config.js';
import type { CreateEventInput, EventRecord } from '../domain/types.js';
import { EventConfigurationError, EventConflictError } from '../gas/repository.js';

type Flash = { type: 'success' | 'error'; message: string };

export type EventRepository = {
  listEvents(): Promise<EventRecord[]>;
  createEvent(input: CreateEventInput): Promise<EventRecord>;
  refreshAggregations(): Promise<void>;
};

export function startWebServer(
  config: AppConfig,
  repository: EventRepository,
  logger: Logger,
): Promise<Server> {
  const csrfToken = randomBytes(32).toString('hex');
  let createQueue: Promise<void> = Promise.resolve();

  const server = createServer(async (request, response) => {
    setSecurityHeaders(response);
    if (request.url === '/health') {
      sendText(response, 200, 'ok');
      return;
    }
    if (!isAuthorized(request, config.web.adminUsername, config.web.adminPassword)) {
      response.setHeader('WWW-Authenticate', 'Basic realm="Flashami Money", charset="UTF-8"');
      sendText(response, 401, '認証が必要です。');
      return;
    }

    const url = new URL(request.url ?? '/', 'http://localhost');
    try {
      if (request.method === 'GET' && url.pathname === '/') {
        const events = await repository.listEvents();
        const flash = url.searchParams.has('created')
          ? url.searchParams.has('aggregation-warning')
            ? {
                type: 'error' as const,
                message:
                  'イベントは作成しましたが、集計表の更新に失敗しました。Discordで /集計更新 を実行してください。',
              }
            : { type: 'success' as const, message: 'イベントを作成しました。' }
          : undefined;
        sendHtml(response, 200, renderDashboard(events, config, csrfToken, flash));
        return;
      }

      if (request.method === 'POST' && url.pathname === '/events') {
        const form = new URLSearchParams(await readRequestBody(request));
        if (form.get('_csrf') !== csrfToken) {
          sendText(
            response,
            403,
            'フォームの有効期限が切れました。ページを再読み込みしてください。',
          );
          return;
        }
        const input = parseEventForm(form, config);
        let aggregationWarning = false;
        const create = createQueue.then(async () => {
          await repository.createEvent(input);
          try {
            await repository.refreshAggregations();
          } catch (error) {
            aggregationWarning = true;
            logger.error({ err: error }, 'aggregation refresh after event creation failed');
          }
        });
        createQueue = create.then(
          () => undefined,
          () => undefined,
        );
        await create;
        response
          .writeHead(303, {
            Location: aggregationWarning ? '/?created=1&aggregation-warning=1' : '/?created=1',
          })
          .end();
        return;
      }

      sendText(response, 404, 'ページが見つかりません。');
    } catch (error) {
      logger.error({ err: error, path: url.pathname }, 'web request failed');
      const message =
        error instanceof WebInputError ||
        error instanceof EventConflictError ||
        error instanceof EventConfigurationError
          ? error.message
          : '処理に失敗しました。GAS Webアプリの設定を確認してください。';
      const events = await repository.listEvents().catch(() => []);
      sendHtml(
        response,
        error instanceof WebInputError ||
          error instanceof EventConflictError ||
          error instanceof EventConfigurationError
          ? 400
          : 500,
        renderDashboard(events, config, csrfToken, { type: 'error', message }),
      );
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.web.port, config.web.host, () => {
      server.off('error', reject);
      resolve(server);
    });
  });
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
      ? `<div class="empty"><strong>イベントはまだありません</strong><p>右のフォームから最初の旅行イベントを作成してください。</p></div>`
      : `<div class="event-list">${events.map(renderEvent).join('')}</div>`;

  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <title>Flashami Money｜イベント管理</title>
  <style>${styles}</style>
</head>
<body>
  <main>
    <header>
      <div class="eyebrow">FLASHAMI MONEY</div>
      <h1>イベント管理</h1>
      <p>旅行ごとに予算とDiscordチャンネルを分けて管理します。</p>
    </header>
    ${flash ? `<div class="flash ${flash.type}" role="status">${escapeHtml(flash.message)}</div>` : ''}
    <section class="metrics" aria-label="イベント概要">
      <div><span>開催中</span><strong>${activeEvents.length}</strong><small>events</small></div>
      <div><span>登録済み</span><strong>${events.length}</strong><small>total</small></div>
      <div><span>開催中の予算</span><strong>¥${formatYen(totalBudget)}</strong><small>JPY</small></div>
    </section>
    <div class="layout">
      <section class="panel list-panel">
        <div class="section-heading"><div><span>EVENTS</span><h2>イベント一覧</h2></div></div>
        ${eventRows}
      </section>
      <section class="panel form-panel">
        <div class="section-heading"><div><span>NEW EVENT</span><h2>イベント作成</h2></div></div>
        <form method="post" action="/events">
          <input type="hidden" name="_csrf" value="${csrfToken}">
          <label>イベント名<input name="name" maxlength="80" placeholder="例：夏合宿 2026" required></label>
          <label>初期予算<input name="initialBudgetYen" inputmode="numeric" value="${config.event.initialBudgetYen}" required><em>円</em></label>
          <label>DiscordチャンネルID<input name="discordChannelId" inputmode="numeric" pattern="[0-9]{17,20}" placeholder="123456789012345678" required></label>
          <label>運営ロールID<input name="operationsRoleId" inputmode="numeric" pattern="[0-9]{17,20}" value="${escapeHtml(config.discord.operationsRoleId)}" required></label>
          <label>イベントのGoogleスプレッドシート<input name="spreadsheet" placeholder="https://docs.google.com/spreadsheets/d/.../edit" required></label>
          <p class="hint">指定した既存スプレッドシートへ「収支・精算」タブを追加し、レシート用フォルダを自動作成します。既存のスケジュール・参加者タブは変更しません。</p>
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
:root{font-family:-apple-system,BlinkMacSystemFont,"Hiragino Sans","Yu Gothic UI",sans-serif;color:#18201b;background:#f2f3ec;font-synthesis:none}*{box-sizing:border-box}body{margin:0;min-height:100vh;background:radial-gradient(circle at 8% 0%,#fff 0,transparent 30%),#f2f3ec}main{width:min(1180px,calc(100% - 32px));margin:auto;padding:64px 0 80px}header{margin-bottom:32px}.eyebrow,.section-heading span{color:#63725f;font-size:12px;font-weight:750;letter-spacing:.16em}h1{font-size:clamp(36px,7vw,68px);letter-spacing:-.055em;line-height:1;margin:10px 0 14px}header p{color:#68706b;font-size:16px;margin:0}.metrics{display:grid;grid-template-columns:repeat(3,1fr);background:#1d2821;color:#fff;border-radius:22px;padding:8px;margin-bottom:20px}.metrics div{padding:22px 24px;border-right:1px solid #3c4940}.metrics div:last-child{border:0}.metrics span,.metrics small{display:block;color:#aeb8b0;font-size:12px}.metrics strong{display:inline-block;font-size:28px;margin:7px 6px 0 0}.metrics small{display:inline}.layout{display:grid;grid-template-columns:minmax(0,1.55fr) minmax(320px,.8fr);gap:20px;align-items:start}.panel{background:rgba(255,255,255,.82);border:1px solid #dfe2d9;border-radius:22px;padding:26px;box-shadow:0 18px 50px rgba(34,44,37,.06)}.section-heading{display:flex;justify-content:space-between;align-items:end;margin-bottom:22px}.section-heading h2{font-size:22px;margin:6px 0 0}.event-list{display:grid;gap:12px}.event-card{border:1px solid #e2e5dd;border-radius:16px;padding:18px;background:#fff}.event-top{display:flex;justify-content:space-between;gap:16px;align-items:start}.event-top h3{font-size:18px;margin:8px 0 0}.event-top>strong{font-size:20px;white-space:nowrap}.status{display:inline-block;border-radius:100px;padding:4px 8px;background:#e3f1df;color:#37613b;font-size:11px;font-weight:700}.status.archived{background:#ececea;color:#6d706c}.event-card dl{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:20px 0}.event-card dl div{min-width:0}.event-card dt{color:#818781;font-size:11px}.event-card dd{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;overflow:hidden;text-overflow:ellipsis;margin:5px 0 0}.event-card a{color:#415c45;font-size:13px;font-weight:700;text-decoration:none}.empty{padding:56px 20px;text-align:center;color:#727a74;border:1px dashed #ccd1c8;border-radius:16px}.empty strong{color:#263029}.empty p{font-size:13px;margin:8px 0 0}form{display:grid;gap:17px}label{position:relative;display:grid;gap:7px;font-size:13px;font-weight:700}input{width:100%;border:1px solid #ccd2c9;background:#fff;border-radius:11px;padding:13px 14px;color:#18201b;font:inherit;outline:none}input:focus{border-color:#526c56;box-shadow:0 0 0 3px rgba(82,108,86,.13)}label em{position:absolute;right:13px;bottom:13px;color:#7b827d;font-size:12px;font-style:normal}.hint{color:#737b75;font-size:12px;line-height:1.65;margin:0}button{border:0;border-radius:12px;background:#263a2c;color:#fff;padding:14px 18px;font:inherit;font-weight:750;cursor:pointer}button:hover{background:#19291e}.flash{border-radius:12px;padding:13px 16px;margin-bottom:20px;font-size:14px}.flash.success{background:#e1f1df;color:#315536}.flash.error{background:#f8e3df;color:#7a342a}@media(max-width:800px){main{padding-top:38px}.layout{grid-template-columns:1fr}.form-panel{grid-row:1}.metrics{grid-template-columns:1fr}.metrics div{border-right:0;border-bottom:1px solid #3c4940}.event-card dl{grid-template-columns:1fr}}`;

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > 32 * 1024) throw new WebInputError('入力内容が大きすぎます。');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function isAuthorized(request: IncomingMessage, username: string, password: string): boolean {
  const authorization = request.headers.authorization;
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

function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  );
  response.setHeader('Cache-Control', 'no-store');
}

function sendHtml(response: ServerResponse, status: number, html: string): void {
  response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' }).end(html);
}

function sendText(response: ServerResponse, status: number, text: string): void {
  response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' }).end(text);
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
