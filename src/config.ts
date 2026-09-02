import { z } from 'zod';

const baseSchema = z.object({
  DISCORD_TOKEN: z.string().min(1),
  DISCORD_CLIENT_ID: z.string().min(1),
  DISCORD_GUILD_ID: z.string().min(1),
  OPERATIONS_ROLE_ID: z.string().min(1),
  GOOGLE_SPREADSHEET_ID: z.string().min(1),
  GOOGLE_DRIVE_FOLDER_ID: z.string().min(1),
  DRIVE_AUTH_MODE: z.literal('oauth').default('oauth'),
  DRIVE_OAUTH_CLIENT_ID: z.string().min(1),
  DRIVE_OAUTH_CLIENT_SECRET: z.string().min(1),
  DRIVE_REFRESH_TOKEN: z.string().min(1),
  EVENT_NAME: z.string().min(1).default('旅行イベント'),
  INITIAL_BUDGET_YEN: z.coerce.number().int().nonnegative().default(0),
  WEB_HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  ADMIN_USERNAME: z.string().min(1).default('admin'),
  ADMIN_PASSWORD: z.string().min(12),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

const sheetsOauthSchema = baseSchema.extend({
  SHEETS_AUTH_MODE: z.literal('oauth'),
  SHEETS_OAUTH_CLIENT_ID: z.string().min(1),
  SHEETS_OAUTH_CLIENT_SECRET: z.string().min(1),
  SHEETS_REFRESH_TOKEN: z.string().min(1),
});

const sheetsServiceAccountSchema = baseSchema.extend({
  SHEETS_AUTH_MODE: z.literal('service-account').default('service-account'),
  SHEETS_CLIENT_EMAIL: z.email(),
  SHEETS_PRIVATE_KEY: z.string().min(1),
});

const envSchema = z.discriminatedUnion('SHEETS_AUTH_MODE', [
  sheetsOauthSchema,
  sheetsServiceAccountSchema,
]);

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadConfig(environment: NodeJS.ProcessEnv = process.env) {
  const result = envSchema.safeParse({
    ...environment,
    SHEETS_AUTH_MODE: environment.SHEETS_AUTH_MODE ?? 'service-account',
    DRIVE_AUTH_MODE: environment.DRIVE_AUTH_MODE ?? 'oauth',
  });
  if (!result.success) {
    const messages = result.error.issues.map(
      (issue) => `${issue.path.join('.') || 'environment'}: ${issue.message}`,
    );
    throw new Error(`環境変数を確認してください:\n${messages.join('\n')}`);
  }

  const common = {
    discord: {
      token: result.data.DISCORD_TOKEN,
      clientId: result.data.DISCORD_CLIENT_ID,
      guildId: result.data.DISCORD_GUILD_ID,
      operationsRoleId: result.data.OPERATIONS_ROLE_ID,
    },
    google: {
      spreadsheetId: result.data.GOOGLE_SPREADSHEET_ID,
      driveFolderId: result.data.GOOGLE_DRIVE_FOLDER_ID,
      driveAuth: {
        mode: 'oauth' as const,
        clientId: result.data.DRIVE_OAUTH_CLIENT_ID,
        clientSecret: result.data.DRIVE_OAUTH_CLIENT_SECRET,
        refreshToken: result.data.DRIVE_REFRESH_TOKEN,
      },
    },
    event: {
      name: result.data.EVENT_NAME,
      initialBudgetYen: result.data.INITIAL_BUDGET_YEN,
    },
    web: {
      host: result.data.WEB_HOST,
      port: result.data.PORT,
      adminUsername: result.data.ADMIN_USERNAME,
      adminPassword: result.data.ADMIN_PASSWORD,
    },
    logLevel: result.data.LOG_LEVEL,
  } as const;

  if (result.data.SHEETS_AUTH_MODE === 'oauth') {
    return {
      ...common,
      google: {
        ...common.google,
        sheetsAuth: {
          mode: 'oauth' as const,
          clientId: result.data.SHEETS_OAUTH_CLIENT_ID,
          clientSecret: result.data.SHEETS_OAUTH_CLIENT_SECRET,
          refreshToken: result.data.SHEETS_REFRESH_TOKEN,
        },
      },
    };
  }

  return {
    ...common,
    google: {
      ...common.google,
      sheetsAuth: {
        mode: 'service-account' as const,
        clientEmail: result.data.SHEETS_CLIENT_EMAIL,
        privateKey: result.data.SHEETS_PRIVATE_KEY.replace(/\\n/g, '\n'),
      },
    },
  };
}
