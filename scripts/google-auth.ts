import { createServer } from 'node:http';

import { google } from 'googleapis';

import { DRIVE_SCOPES, SHEETS_SCOPES } from '../src/google/auth.js';

const target = process.argv[2] ?? 'drive';
if (target !== 'drive' && target !== 'sheets') {
  throw new Error('対象は drive または sheets を指定してください。');
}

const prefix = target === 'drive' ? 'DRIVE' : 'SHEETS';
const clientId = requiredEnv(`${prefix}_OAUTH_CLIENT_ID`);
const clientSecret = requiredEnv(`${prefix}_OAUTH_CLIENT_SECRET`);
const scopes = target === 'drive' ? DRIVE_SCOPES : SHEETS_SCOPES;
const port = 53_682;
const redirectUri = `http://127.0.0.1:${port}/oauth2callback`;
const client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
const authUrl = client.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent',
  scope: scopes,
});

console.log(
  `次のURLをブラウザで開き、${target === 'drive' ? '個人Drive' : '会社Sheets'}へのアクセスを許可してください。`,
);
console.log(authUrl);
console.log(`OAuthクライアントにはリダイレクトURI ${redirectUri} を登録してください。`);

const refreshToken = await new Promise<string>((resolve, reject) => {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', redirectUri);
    if (url.pathname !== '/oauth2callback') {
      response.writeHead(404).end('Not found');
      return;
    }

    const code = url.searchParams.get('code');
    const oauthError = url.searchParams.get('error');
    if (!code || oauthError) {
      response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end(`Google認証に失敗しました: ${oauthError ?? 'code missing'}`);
      server.close();
      reject(new Error(oauthError ?? 'Authorization code missing'));
      return;
    }

    try {
      const { tokens } = await client.getToken(code);
      if (!tokens.refresh_token) throw new Error('Refresh token was not returned');
      response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('認証できました。このタブを閉じてターミナルへ戻ってください。');
      server.close();
      resolve(tokens.refresh_token);
    } catch (error) {
      response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('トークン取得に失敗しました。ターミナルを確認してください。');
      server.close();
      reject(error);
    }
  });

  server.on('error', reject);
  server.listen(port, '127.0.0.1');
});

console.log('\n次の値をローカルの .env に保存してください。チャットやGitには貼らないでください。');
console.log(`${prefix}_REFRESH_TOKEN=${refreshToken}`);

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} を .env に設定してください。`);
  return value;
}
