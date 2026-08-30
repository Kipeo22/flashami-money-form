import { z } from 'zod';

const baseSchema = z.object({
  DISCORD_TOKEN: z.string().min(1),
  DISCORD_CLIENT_ID: z.string().min(1),
  DISCORD_GUILD_ID: z.string().min(1),
  OPERATIONS_ROLE_ID: z.string().min(1),
  GOOGLE_SPREADSHEET_ID: z.string().min(1),
  GOOGLE_DRIVE_FOLDER_ID: z.string().min(1),
  EVENT_NAME: z.string().min(1).default('旅行イベント'),
  INITIAL_BUDGET_YEN: z.coerce.number().int().nonnegative().default(0),
  WEB_HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  ADMIN_USERNAME: z.string().min(1).default('admin'),
  ADMIN_PASSWORD: z.string().min(12),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

const oauthSchema = baseSchema.extend({
  GOOGLE_AUTH_MODE: z.literal('oauth').default('oauth'),
  GOOGLE_OAUTH_CLIENT_ID: z.string().min(1),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().min(1),
  GOOGLE_REFRESH_TOKEN: z.string().min(1),
});

const serviceAccountSchema = baseSchema.extend({
  GOOGLE_AUTH_MODE: z.literal('service-account'),
  GOOGLE_CLIENT_EMAIL: z.email(),
  GOOGLE_PRIVATE_KEY: z.string().min(1),
});

const envSchema = z.discriminatedUnion('GOOGLE_AUTH_MODE', [oauthSchema, serviceAccountSchema]);

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadConfig(environment: NodeJS.ProcessEnv = process.env) {
  const input = {
    ...environment,
    GOOGLE_AUTH_MODE: environment.GOOGLE_AUTH_MODE ?? 'oauth',
  };
  const result = envSchema.safeParse(input);
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

  if (result.data.GOOGLE_AUTH_MODE === 'oauth') {
    return {
      ...common,
      google: {
        ...common.google,
        auth: {
          mode: 'oauth' as const,
          clientId: result.data.GOOGLE_OAUTH_CLIENT_ID,
          clientSecret: result.data.GOOGLE_OAUTH_CLIENT_SECRET,
          refreshToken: result.data.GOOGLE_REFRESH_TOKEN,
        },
      },
    };
  }

  return {
    ...common,
    google: {
      ...common.google,
      auth: {
        mode: 'service-account' as const,
        clientEmail: result.data.GOOGLE_CLIENT_EMAIL,
        privateKey: result.data.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      },
    },
  };
}
