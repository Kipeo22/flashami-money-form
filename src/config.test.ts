import { describe, expect, it } from 'vitest';

import { loadConfig } from './config.js';

const common = {
  DISCORD_TOKEN: 'token',
  DISCORD_CLIENT_ID: '123456789012345678',
  DISCORD_PUBLIC_KEY: 'a'.repeat(64),
  DISCORD_GUILD_ID: '123456789012345678',
  OPERATIONS_ROLE_ID: '223456789012345678',
  GAS_WEB_APP_URL: 'https://script.google.com/macros/s/deployment/exec',
  GAS_SHARED_SECRET: 'a-secure-shared-secret-with-32-chars',
  ADMIN_PASSWORD: 'long-test-password',
};

describe('loadConfig', () => {
  it('loads the GAS Web API configuration', () => {
    const config = loadConfig(common);

    expect(config.gas).toEqual({
      webAppUrl: 'https://script.google.com/macros/s/deployment/exec',
      sharedSecret: 'a-secure-shared-secret-with-32-chars',
    });
    expect(config.discord.publicKey).toBe('a'.repeat(64));
  });

  it('requires a long shared secret and HTTPS URL', () => {
    expect(() =>
      loadConfig({
        ...common,
        GAS_WEB_APP_URL: 'http://example.com/gas',
        GAS_SHARED_SECRET: 'short',
      }),
    ).toThrow(/GAS_WEB_APP_URL|GAS_SHARED_SECRET/);
  });

  it('keeps the web defaults', () => {
    const config = loadConfig({
      ...common,
    });

    expect(config.web.host).toBe('127.0.0.1');
    expect(config.web.port).toBe(3000);
  });
});
