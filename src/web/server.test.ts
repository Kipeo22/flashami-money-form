import { describe, expect, it } from 'vitest';

import { loadConfig } from '../config.js';
import type { EventRecord } from '../domain/types.js';
import { parseEventForm, renderDashboard } from './server.js';

const config = loadConfig({
  DISCORD_TOKEN: 'token',
  DISCORD_CLIENT_ID: '123456789012345678',
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

  it('renders an empty state and an event list', () => {
    expect(renderDashboard([], config, 'csrf')).toContain('イベントはまだありません');

    const event: EventRecord = {
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
    const html = renderDashboard([event], config, 'csrf');
    expect(html).toContain('夏合宿 2026');
    expect(html).toContain('¥100,000');
    expect(html).toContain('323456789012345678');
    expect(html).toContain('event-spreadsheet');
  });
});
