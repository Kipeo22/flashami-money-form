import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { loadConfig } from '../config.js';
import {
  EventConfigurationError,
  EventConflictError,
  ExpenseConflictError,
  GasRepository,
} from './repository.js';

const sharedSecret = 'a-secure-shared-secret-with-32-chars';
const config = loadConfig({
  DISCORD_TOKEN: 'token',
  DISCORD_CLIENT_ID: '123456789012345678',
  DISCORD_PUBLIC_KEY: 'a'.repeat(64),
  DISCORD_GUILD_ID: '123456789012345678',
  OPERATIONS_ROLE_ID: '223456789012345678',
  GAS_WEB_APP_URL: 'https://script.google.com/macros/s/deployment/exec',
  GAS_SHARED_SECRET: sharedSecret,
  ADMIN_PASSWORD: 'long-test-password',
});

describe('GasRepository', () => {
  it('signs requests and parses event rows', async () => {
    const repository = new GasRepository(
      config,
      mockFetch((request) => {
        expect(request.action).toBe('listEvents');
        return {
          ok: true,
          data: [
            [
              'event-1',
              '夏合宿',
              100_000,
              '123456789012345678',
              '323456789012345678',
              '223456789012345678',
              'drive-folder',
              'event-spreadsheet',
              'active',
              '2026-09-02T00:00:00.000Z',
            ],
          ],
        };
      }),
    );

    await expect(repository.listEvents()).resolves.toEqual([
      expect.objectContaining({
        id: 'event-1',
        name: '夏合宿',
        initialBudgetYen: 100_000,
        spreadsheetId: 'event-spreadsheet',
      }),
    ]);
    expect(
      repository.findCachedActiveEvent('123456789012345678', '323456789012345678'),
    ).toMatchObject({ id: 'event-1', name: '夏合宿' });
  });

  it('checks duplicate expenses within the selected event', async () => {
    const repository = new GasRepository(
      config,
      mockFetch((request) => {
        expect(request.action).toBe('hasExpense');
        expect(request.payload).toEqual({ expenseId: 'expense-1', eventId: 'event-1' });
        return { ok: true, data: true };
      }),
    );

    await expect(repository.hasExpense('expense-1', 'event-1')).resolves.toBe(true);
  });

  it('retries a transient 404 for read-only GAS requests', async () => {
    let calls = 0;
    const fetchImplementation: typeof fetch = async () => {
      calls += 1;
      if (calls === 1) return new Response('temporary error', { status: 404 });
      return new Response(JSON.stringify({ ok: true, data: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    const repository = new GasRepository(config, fetchImplementation);

    await expect(repository.listEvents()).resolves.toEqual([]);
    expect(calls).toBe(2);
  });

  it('does not retry receipt uploads after a transient response error', async () => {
    let calls = 0;
    const fetchImplementation: typeof fetch = async () => {
      calls += 1;
      return new Response('temporary error', { status: 404 });
    };
    const repository = new GasRepository(config, fetchImplementation);

    await expect(
      repository.uploadReceipt(
        { buffer: Buffer.from('receipt'), filename: 'receipt.pdf', mimeType: 'application/pdf' },
        'folder-1',
      ),
    ).rejects.toThrow('GASへの接続に失敗しました (404)。');
    expect(calls).toBe(1);
  });

  it('maps an event conflict to the domain error', async () => {
    const repository = new GasRepository(
      config,
      mockFetch(() => ({
        ok: false,
        error: { code: 'EVENT_CONFLICT', message: 'このチャンネルは使用中です。' },
      })),
    );

    await expect(
      repository.createEvent({
        name: '夏合宿',
        initialBudgetYen: 100_000,
        discordGuildId: '123456789012345678',
        discordChannelId: '323456789012345678',
        operationsRoleId: '223456789012345678',
        spreadsheetId: '1AbCdEfGhIjKlMnOpQrStUvWxYz1234567890',
      }),
    ).rejects.toBeInstanceOf(EventConflictError);
  });

  it('returns a user-facing error when the event spreadsheet cannot be opened', async () => {
    const repository = new GasRepository(
      config,
      mockFetch(() => ({
        ok: false,
        error: { code: 'SPREADSHEET_ACCESS', message: 'スプレッドシートを開けません。' },
      })),
    );

    await expect(
      repository.createEvent({
        name: '夏合宿',
        initialBudgetYen: 100_000,
        discordGuildId: '123456789012345678',
        discordChannelId: '323456789012345678',
        operationsRoleId: '223456789012345678',
        spreadsheetId: '1AbCdEfGhIjKlMnOpQrStUvWxYz1234567890',
      }),
    ).rejects.toBeInstanceOf(EventConfigurationError);
  });

  it('sends receipt bytes as base64', async () => {
    const repository = new GasRepository(
      config,
      mockFetch((request) => {
        expect(request.action).toBe('uploadReceipt');
        expect(request.payload).toMatchObject({ base64: 'cmVjZWlwdA==' });
        return { ok: true, data: { id: 'file-1', url: 'https://drive.google.com/file-1' } };
      }),
    );

    await expect(
      repository.uploadReceipt(
        { buffer: Buffer.from('receipt'), filename: 'receipt.pdf', mimeType: 'application/pdf' },
        'folder-1',
      ),
    ).resolves.toEqual({ id: 'file-1', url: 'https://drive.google.com/file-1' });
  });

  it('stores operations expenses with empty target arrays', async () => {
    const repository = new GasRepository(
      config,
      mockFetch((request) => {
        expect(request.action).toBe('appendExpense');
        const row = (request.payload as { row: unknown[] }).row;
        expect(row.slice(8, 12)).toEqual(['運営', '[]', '[]', '運営']);
        return { ok: true, data: null };
      }),
    );

    await repository.appendExpense({
      id: 'expense-1',
      event: { id: 'event-1', name: '夏合宿' },
      createdAt: '2026-09-02T00:00:00.000Z',
      guildId: '123456789012345678',
      channelId: '323456789012345678',
      submittedBy: { id: 'user-1', name: '登録者' },
      payer: { id: 'user-2', name: '支払者' },
      target: { type: 'operations' },
      item: 'ガソリン代',
      amountYen: 5_000,
      receiptFileId: 'file-1',
      receiptUrl: 'https://drive.google.com/file-1',
      receiptName: 'receipt.pdf',
    });
  });

  it('stores a receipt and expense in one GAS request', async () => {
    const repository = new GasRepository(
      config,
      mockFetch((request) => {
        expect(request.action).toBe('saveExpense');
        expect(request.payload).toMatchObject({
          receipt: {
            eventFolderId: 'folder-1',
            filename: 'receipt.pdf',
            mimeType: 'application/pdf',
            base64: 'cmVjZWlwdA==',
          },
        });
        return { ok: true, data: { id: 'file-1', url: 'https://drive.google.com/file-1' } };
      }),
    );

    await expect(
      repository.saveExpense(exampleExpense(), 'folder-1', {
        buffer: Buffer.from('receipt'),
        filename: 'receipt.pdf',
        mimeType: 'application/pdf',
      }),
    ).resolves.toEqual({ id: 'file-1', url: 'https://drive.google.com/file-1' });
  });

  it('maps a duplicate append to the domain error', async () => {
    const repository = new GasRepository(
      config,
      mockFetch(() => ({
        ok: false,
        error: { code: 'EXPENSE_CONFLICT', message: 'この支出は登録済みです。' },
      })),
    );

    await expect(repository.appendExpense(exampleExpense())).rejects.toBeInstanceOf(
      ExpenseConflictError,
    );
  });

  it('accepts an ambiguous append response when the expense was stored', async () => {
    let calls = 0;
    const fetchImplementation: typeof fetch = async () => {
      calls += 1;
      if (calls === 1) {
        return new Response('<html>temporary response</html>', {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        });
      }
      return new Response(JSON.stringify({ ok: true, data: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    const repository = new GasRepository(config, fetchImplementation);

    await expect(repository.appendExpense(exampleExpense())).resolves.toBeUndefined();
    expect(calls).toBe(2);
  });

  it('reconciles an ambiguous combined save response without writing twice', async () => {
    let calls = 0;
    const fetchImplementation: typeof fetch = async () => {
      calls += 1;
      if (calls === 1) {
        return new Response('<html>temporary response</html>', {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        });
      }
      return new Response(JSON.stringify({ ok: true, data: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    const repository = new GasRepository(config, fetchImplementation);

    await expect(repository.saveExpense(exampleExpense(), 'folder-1', null)).resolves.toBeNull();
    expect(calls).toBe(2);
  });

  it('reads legacy operations expenses whose target name contains 運営', async () => {
    const repository = new GasRepository(
      config,
      mockFetch((request) => {
        if (request.action === 'readExpenses') {
          return {
            ok: true,
            data: [
              [
                'expense-1',
                '2026-09-02T00:00:00.000Z',
                '123456789012345678',
                '323456789012345678',
                'user-1',
                '登録者',
                'user-2',
                '支払者',
                '運営',
                '[]',
                '["運営"]',
                '運営',
                'ガソリン代',
                5_000,
                '',
                '',
                '',
                'event-1',
                '夏合宿',
              ],
            ],
          };
        }
        if (request.action === 'listEvents') {
          return {
            ok: true,
            data: [
              [
                'event-1',
                '夏合宿',
                100_000,
                '123456789012345678',
                '323456789012345678',
                '223456789012345678',
                'drive-folder',
                'event-spreadsheet',
                'active',
                '2026-09-02T00:00:00.000Z',
              ],
            ],
          };
        }
        expect(request.action).toBe('replaceAggregations');
        const payload = request.payload as { settlementRows: unknown[][]; budgetRows: unknown[][] };
        expect(payload.settlementRows).toHaveLength(1);
        expect(payload.budgetRows[1]).toEqual([
          'event-1',
          '夏合宿',
          100_000,
          5_000,
          95_000,
          expect.any(String),
        ]);
        return { ok: true, data: null };
      }),
    );

    await expect(repository.refreshAggregations()).resolves.toBeUndefined();
  });
});

function exampleExpense() {
  return {
    id: 'expense-1',
    event: { id: 'event-1', name: '夏合宿' },
    createdAt: '2026-09-02T00:00:00.000Z',
    guildId: '123456789012345678',
    channelId: '323456789012345678',
    submittedBy: { id: 'user-1', name: '登録者' },
    payer: { id: 'user-2', name: '支払者' },
    target: { type: 'operations' as const },
    item: 'ガソリン代',
    amountYen: 5_000,
    receiptFileId: '',
    receiptUrl: '',
    receiptName: '',
  };
}

type SignedRequest = {
  action: string;
  payload: unknown;
};

function mockFetch(handler: (request: SignedRequest) => unknown): typeof fetch {
  return async (_input, init) => {
    const envelope = JSON.parse(String(init?.body)) as { body: string; signature: string };
    const expected = createHmac('sha256', sharedSecret).update(envelope.body).digest('base64url');
    expect(envelope.signature).toBe(expected);
    const request = JSON.parse(envelope.body) as SignedRequest;
    return new Response(JSON.stringify(handler(request)), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
}
