import { describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../config.js';
import type { EventRecord } from '../domain/types.js';
import {
  handleAdminRequest,
  parseEventForm,
  parseOperationsExpenseForm,
  renderDashboard,
} from './server.js';

const config = loadConfig({
  DISCORD_TOKEN: 'token',
  DISCORD_CLIENT_ID: '123456789012345678',
  DISCORD_PUBLIC_KEY: 'a'.repeat(64),
  DISCORD_GUILD_ID: '123456789012345678',
  OPERATIONS_ROLE_ID: '223456789012345678',
  GAS_WEB_APP_URL: 'https://script.google.com/macros/s/deployment/exec',
  GAS_SHARED_SECRET: 'a-secure-shared-secret-with-32-chars',
  ADMIN_PASSWORD: 'long-test-password',
});

describe('event management web screen', () => {
  it('parses a new event form', () => {
    const input = parseEventForm(
      new URLSearchParams({
        name: '夏合宿 2026',
        initialBudgetYen: '100,000',
        discordChannelId: '323456789012345678',
        operationsRoleId: '223456789012345678',
        spreadsheet:
          'https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz1234567890/edit',
      }),
      config,
    );

    expect(input).toEqual({
      name: '夏合宿 2026',
      initialBudgetYen: 100_000,
      discordGuildId: '123456789012345678',
      discordChannelId: '323456789012345678',
      operationsRoleId: '223456789012345678',
      spreadsheetId: '1AbCdEfGhIjKlMnOpQrStUvWxYz1234567890',
    });
  });

  it('parses an operations expense without Discord user input', () => {
    const expense = parseOperationsExpenseForm(
      new URLSearchParams({
        expenseId: 'web-12345678-1234-4123-8123-123456789abc',
        eventId: 'event-1',
        item: '宿泊施設の予約金',
        amountYen: '30,000',
      }),
      [exampleEvent()],
    );

    expect(expense).toMatchObject({
      id: 'web-12345678-1234-4123-8123-123456789abc',
      event: { id: 'event-1', name: '夏合宿 2026' },
      guildId: '123456789012345678',
      channelId: '323456789012345678',
      submittedBy: { id: 'web-admin-operations', name: 'Flashami運営' },
      payer: { id: 'web-admin-operations', name: 'Flashami運営' },
      target: { type: 'operations' },
      item: '宿泊施設の予約金',
      amountYen: 30_000,
      receiptUrl: '',
    });
  });

  it('renders an empty state and an event list', () => {
    expect(renderDashboard([], config, 'csrf')).toContain('イベントはまだありません');

    const event = exampleEvent();
    const html = renderDashboard([event], config, 'csrf');
    expect(html).toContain('夏合宿 2026');
    expect(html).toContain('¥100,000');
    expect(html).toContain('323456789012345678');
    expect(html).toContain('event-spreadsheet');
    expect(html).toContain('運営支出を登録');
    expect(html).toContain('集計を再計算');
    expect(html).toContain('<option value="event-1">夏合宿 2026</option>');
    expect(html).toContain('管理ダッシュボード');
    expect(html).toContain('Discord詳細設定');
    expect(html).toContain('通常は変更不要');
    expect(html.indexOf('運営ロールID')).toBeGreaterThan(html.indexOf('Discord詳細設定'));
  });

  it('refreshes aggregations from the protected management screen', async () => {
    const repository = {
      listEvents: vi.fn(async () => [exampleEvent()]),
      createEvent: vi.fn(),
      saveExpense: vi.fn(),
      refreshAggregations: vi.fn(async () => undefined),
    };
    const logger = { error: vi.fn() };
    const authorization = `Basic ${Buffer.from('admin:long-test-password').toString('base64')}`;
    const page = await handleAdminRequest(
      new Request('https://example.vercel.app/', { headers: { authorization } }),
      config,
      repository,
      logger,
    );
    const csrf = (await page.text()).match(/name="_csrf" value="([^"]+)"/)?.[1] ?? '';

    const response = await handleAdminRequest(
      new Request('https://example.vercel.app/api/admin', {
        method: 'POST',
        headers: { authorization, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          _csrf: csrf,
          _action: 'refresh-aggregations',
        }),
      }),
      config,
      repository,
      logger,
    );

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/?aggregation-refreshed=1');
    expect(repository.refreshAggregations).toHaveBeenCalledOnce();
  });

  it('registers an operations expense and refreshes the budget aggregation', async () => {
    const event = exampleEvent();
    const repository = {
      listEvents: vi.fn(async () => [event]),
      createEvent: vi.fn(),
      saveExpense: vi.fn(async () => null),
      refreshAggregations: vi.fn(async () => undefined),
    };
    const logger = { error: vi.fn() };
    const authorization = `Basic ${Buffer.from('admin:long-test-password').toString('base64')}`;
    const page = await handleAdminRequest(
      new Request('https://example.vercel.app/', { headers: { authorization } }),
      config,
      repository,
      logger,
    );
    const csrf = (await page.text()).match(/name="_csrf" value="([^"]+)"/)?.[1] ?? '';
    const body = new URLSearchParams({
      _csrf: csrf,
      _action: 'create-operations-expense',
      expenseId: 'web-12345678-1234-4123-8123-123456789abc',
      eventId: 'event-1',
      item: '宿泊施設の予約金',
      amountYen: '30000',
    });

    const response = await handleAdminRequest(
      new Request('https://example.vercel.app/api/admin', {
        method: 'POST',
        headers: { authorization, 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      }),
      config,
      repository,
      logger,
    );

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/?expense-created=1');
    expect(repository.saveExpense).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { type: 'operations' },
        item: '宿泊施設の予約金',
        amountYen: 30_000,
      }),
      'drive-folder',
      null,
    );
    expect(repository.refreshAggregations).toHaveBeenCalledOnce();
  });

  it('keeps Basic auth and CSRF protection without in-memory state', async () => {
    const repository = {
      listEvents: vi.fn(async () => []),
      createEvent: vi.fn(),
      saveExpense: vi.fn(),
      refreshAggregations: vi.fn(),
    };
    const logger = { error: vi.fn() };
    const unauthorized = await handleAdminRequest(
      new Request('https://example.vercel.app/'),
      config,
      repository,
      logger,
    );
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get('www-authenticate')).toContain('Basic');

    const authorization = `Basic ${Buffer.from('admin:long-test-password').toString('base64')}`;
    const first = await handleAdminRequest(
      new Request('https://example.vercel.app/', { headers: { authorization } }),
      config,
      repository,
      logger,
    );
    const second = await handleAdminRequest(
      new Request('https://example.vercel.app/', { headers: { authorization } }),
      config,
      repository,
      logger,
    );
    const firstToken = (await first.text()).match(/name="_csrf" value="([^"]+)"/)?.[1];
    const secondToken = (await second.text()).match(/name="_csrf" value="([^"]+)"/)?.[1];
    expect(firstToken).toBeTruthy();
    expect(secondToken).toBe(firstToken);
  });
});

function exampleEvent(): EventRecord {
  return {
    id: 'event-1',
    name: '夏合宿 2026',
    initialBudgetYen: 100_000,
    discordGuildId: '123456789012345678',
    discordChannelId: '323456789012345678',
    operationsRoleId: '223456789012345678',
    driveFolderId: 'drive-folder',
    spreadsheetId: 'event-spreadsheet',
    status: 'active',
    createdAt: '2026-08-29T00:00:00.000Z',
  };
}
