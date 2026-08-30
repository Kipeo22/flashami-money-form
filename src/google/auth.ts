import { google } from 'googleapis';

import type { AppConfig } from '../config.js';

export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/spreadsheets',
];

export function createGoogleAuth(config: AppConfig) {
  if (config.google.auth.mode === 'oauth') {
    const client = new google.auth.OAuth2(
      config.google.auth.clientId,
      config.google.auth.clientSecret,
    );
    client.setCredentials({ refresh_token: config.google.auth.refreshToken });
    return client;
  }

  return new google.auth.JWT({
    email: config.google.auth.clientEmail,
    key: config.google.auth.privateKey,
    scopes: GOOGLE_SCOPES,
  });
}
