import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { loadConfig } from '../config.js';
import { EventConflictError, GasRepository } from './repository.js';

const sharedSecret = 'a-secure-shared-secret-with-32-chars';
const config = loadConfig({
  DISCORD_TOKEN: 'token',
  DISCORD_CLIENT_ID: '123456789012345678',
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
              'active',
              '2026-09-02T00:00:00.000Z',
            ],
          ],
        };
      }),
    );

    await expect(repository.listEvents()).resolves.toEqual([
      expect.objectContaining({ id: 'event-1', name: '夏合宿', initialBudgetYen: 100_000 }),
    ]);
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
      }),
    ).rejects.toBeInstanceOf(EventConflictError);
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
});

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
