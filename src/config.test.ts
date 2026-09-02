import { describe, expect, it } from 'vitest';

import { loadConfig } from './config.js';

const common = {
  DISCORD_TOKEN: 'token',
  DISCORD_CLIENT_ID: '123456789012345678',
  DISCORD_GUILD_ID: '123456789012345678',
  OPERATIONS_ROLE_ID: '223456789012345678',
  GOOGLE_SPREADSHEET_ID: 'company-sheet',
  GOOGLE_DRIVE_FOLDER_ID: 'personal-folder',
  DRIVE_OAUTH_CLIENT_ID: 'personal-client',
  DRIVE_OAUTH_CLIENT_SECRET: 'personal-secret',
  DRIVE_REFRESH_TOKEN: 'personal-refresh',
  ADMIN_PASSWORD: 'long-test-password',
};

describe('loadConfig', () => {
  it('separates company Sheets service account and personal Drive OAuth', () => {
    const config = loadConfig({
      ...common,
      SHEETS_AUTH_MODE: 'service-account',
      SHEETS_CLIENT_EMAIL: 'bot@company.example',
      SHEETS_PRIVATE_KEY: 'line1\\nline2',
    });

    expect(config.google.sheetsAuth).toEqual({
      mode: 'service-account',
      clientEmail: 'bot@company.example',
      privateKey: 'line1\nline2',
    });
    expect(config.google.driveAuth).toEqual({
      mode: 'oauth',
      clientId: 'personal-client',
      clientSecret: 'personal-secret',
      refreshToken: 'personal-refresh',
    });
  });

  it('also supports company Sheets OAuth independently', () => {
    const config = loadConfig({
      ...common,
      SHEETS_AUTH_MODE: 'oauth',
      SHEETS_OAUTH_CLIENT_ID: 'company-client',
      SHEETS_OAUTH_CLIENT_SECRET: 'company-secret',
      SHEETS_REFRESH_TOKEN: 'company-refresh',
    });

    expect(config.google.sheetsAuth).toEqual({
      mode: 'oauth',
      clientId: 'company-client',
      clientSecret: 'company-secret',
      refreshToken: 'company-refresh',
    });
    expect(config.google.driveAuth.refreshToken).toBe('personal-refresh');
  });
});
