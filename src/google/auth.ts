import { google } from 'googleapis';

import type { AppConfig } from '../config.js';

export const SHEETS_SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];
export const DRIVE_SCOPES = ['https://www.googleapis.com/auth/drive'];

export function createSheetsAuth(config: AppConfig) {
  const auth = config.google.sheetsAuth;
  if (auth.mode === 'oauth') {
    return createOauthClient(auth.clientId, auth.clientSecret, auth.refreshToken);
  }
  return new google.auth.JWT({
    email: auth.clientEmail,
    key: auth.privateKey,
    scopes: SHEETS_SCOPES,
  });
}

export function createDriveAuth(config: AppConfig) {
  const auth = config.google.driveAuth;
  return createOauthClient(auth.clientId, auth.clientSecret, auth.refreshToken);
}

function createOauthClient(clientId: string, clientSecret: string, refreshToken: string) {
  const client = new google.auth.OAuth2(clientId, clientSecret);
  client.setCredentials({ refresh_token: refreshToken });
  return client;
}
