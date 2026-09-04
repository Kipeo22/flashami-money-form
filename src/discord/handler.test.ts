import { generateKeyPairSync, sign } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../config.js';
import type { EventRecord } from '../domain/types.js';
import type { InteractionRepository } from './handler.js';
import { handleDiscordInteraction } from './handler.js';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const publicKeyHex = Buffer.from(publicKey.export({ format: 'der', type: 'spki' }))
  .subarray(-32)
  .toString('hex');
const config = loadConfig({
  DISCORD_TOKEN: 'token',
  DISCORD_CLIENT_ID: '123456789012345678',
  DISCORD_PUBLIC_KEY: publicKeyHex,
  DISCORD_GUILD_ID: '123456789012345678',
  OPERATIONS_ROLE_ID: '223456789012345678',
  GAS_WEB_APP_URL: 'https://script.google.com/macros/s/deployment/exec',
  GAS_SHARED_SECRET: 'a-secure-shared-secret-with-32-chars',
  ADMIN_PASSWORD: 'long-test-password',
});

const event: EventRecord = {
  id: 'event-1',
  name: '夏合宿',
  initialBudgetYen: 100_000,
  discordGuildId: '123456789012345678',
  discordChannelId: '323456789012345678',
  operationsRoleId: '223456789012345678',
  driveFolderId: 'drive-folder',
  spreadsheetId: 'event-spreadsheet',
  status: 'active',
  createdAt: '2026-09-02T00:00:00.000Z',
};

describe('Discord HTTP interactions', () => {
  it('verifies Discord signatures and responds to PING', async () => {
    const response = await handleDiscordInteraction(signedRequest({ type: 1 }), dependencies());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ type: 1 });
  });

  it('rejects an invalid signature', async () => {
    const request = signedRequest({ type: 1 });
    request.headers.set('x-signature-ed25519', '0'.repeat(128));

    const response = await handleDiscordInteraction(request, dependencies());

    expect(response.status).toBe(401);
  });

  it('opens the expense modal without waiting for GAS', async () => {
    const repository = repositoryMock();
    const response = await handleDiscordInteraction(
      signedRequest({
        type: 2,
        channel_id: event.discordChannelId,
        data: { name: '支出登録' },
      }),
      dependencies(repository),
    );

    expect(await response.json()).toMatchObject({
      type: 9,
      data: { custom_id: `expense:modal:channel:${event.discordChannelId}`, title: '支出登録' },
    });
    expect(repository.findActiveEvent).not.toHaveBeenCalled();
  });

  it('defers a modal immediately, stores it, then updates the reply before aggregation', async () => {
    const repository = repositoryMock();
    const calls: string[] = [];
    repository.findActiveEvent.mockImplementation(async () => {
      calls.push('event');
      return event;
    });
    repository.saveExpense.mockImplementation(async () => {
      calls.push('save');
      return null;
    });
    repository.refreshAggregations.mockImplementation(async () => {
      calls.push('aggregate');
    });
    const fetchImplementation: typeof fetch = async (_input, init) => {
      if (init?.method === 'PATCH') calls.push('reply');
      return new Response('{}', { status: 200 });
    };
    let backgroundTask: Promise<unknown> | undefined;
    const response = await handleDiscordInteraction(
      signedRequest(modalInteraction()),
      dependencies(repository, {
        fetchImplementation,
        deferTask: (task) => {
          backgroundTask = task;
        },
      }),
    );

    expect(await response.json()).toEqual({ type: 5 });
    expect(backgroundTask).toBeDefined();
    await backgroundTask;
    expect(repository.saveExpense).toHaveBeenCalledWith(
      expect.objectContaining({ item: 'ガソリン代', amountYen: 5000 }),
      'drive-folder',
      null,
    );
    expect(calls).toEqual(['event', 'save', 'reply', 'aggregate']);
  });
});

function modalInteraction() {
  return {
    id: '1413207927731945472',
    application_id: '123456789012345678',
    token: 'interaction-token',
    type: 5,
    guild_id: event.discordGuildId,
    channel_id: event.discordChannelId,
    member: {
      nick: '登録者',
      roles: [],
      user: { id: '423456789012345678', username: 'submitter', global_name: null },
    },
    data: {
      custom_id: `expense:modal:channel:${event.discordChannelId}`,
      components: [
        label({ type: 5, custom_id: 'expense:payer', values: ['523456789012345678'] }),
        label({ type: 7, custom_id: 'expense:targets', values: ['623456789012345678'] }),
        label({ type: 4, custom_id: 'expense:item', value: 'ガソリン代' }),
        label({ type: 4, custom_id: 'expense:amount', value: '5,000' }),
        label({ type: 19, custom_id: 'expense:receipt', values: [] }),
      ],
      resolved: {
        users: {
          '523456789012345678': {
            id: '523456789012345678',
            username: 'payer',
            global_name: '支払者',
          },
          '623456789012345678': {
            id: '623456789012345678',
            username: 'target',
            global_name: '対象者',
          },
        },
        members: {},
        roles: {},
        attachments: {},
      },
    },
  };
}

function label(component: Record<string, unknown>) {
  return { type: 18, component };
}

function signedRequest(body: unknown): Request {
  const rawBody = JSON.stringify(body);
  const timestamp = '1788476400';
  const signature = sign(null, Buffer.from(timestamp + rawBody), privateKey).toString('hex');
  return new Request('https://example.vercel.app/api/interactions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Signature-Ed25519': signature,
      'X-Signature-Timestamp': timestamp,
    },
    body: rawBody,
  });
}

function repositoryMock() {
  return {
    getEvent: vi.fn<InteractionRepository['getEvent']>(async () => event),
    findActiveEvent: vi.fn<InteractionRepository['findActiveEvent']>(async () => event),
    saveExpense: vi.fn<InteractionRepository['saveExpense']>(async () => null),
    refreshAggregations: vi.fn<InteractionRepository['refreshAggregations']>(async () => undefined),
  };
}

function dependencies(
  repository = repositoryMock(),
  overrides: Partial<Parameters<typeof handleDiscordInteraction>[1]> = {},
): Parameters<typeof handleDiscordInteraction>[1] {
  return {
    config,
    repository,
    logger: { error: vi.fn() },
    deferTask: () => undefined,
    ...overrides,
  };
}
