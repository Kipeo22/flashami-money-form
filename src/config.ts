import { z } from 'zod';

const envSchema = z.object({
  DISCORD_TOKEN: z.string().min(1),
  DISCORD_CLIENT_ID: z.string().min(1),
  DISCORD_PUBLIC_KEY: z.string().regex(/^[a-fA-F0-9]{64}$/, '64桁の16進数を指定してください'),
  DISCORD_GUILD_ID: z.string().min(1),
  OPERATIONS_ROLE_ID: z.string().min(1),
  GAS_WEB_APP_URL: z.url().refine((value) => value.startsWith('https://'), {
    message: 'HTTPSのURLを指定してください',
  }),
  GAS_SHARED_SECRET: z.string().min(32),
  EVENT_NAME: z.string().min(1).default('旅行イベント'),
  INITIAL_BUDGET_YEN: z.coerce.number().int().nonnegative().default(0),
  WEB_HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  ADMIN_USERNAME: z.string().min(1).default('admin'),
  ADMIN_PASSWORD: z.string().min(12),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadConfig(environment: NodeJS.ProcessEnv = process.env) {
  const result = envSchema.safeParse(environment);
  if (!result.success) {
    const messages = result.error.issues.map(
      (issue) => `${issue.path.join('.') || 'environment'}: ${issue.message}`,
    );
    throw new Error(`環境変数を確認してください:\n${messages.join('\n')}`);
  }

  return {
    discord: {
      token: result.data.DISCORD_TOKEN,
      clientId: result.data.DISCORD_CLIENT_ID,
      publicKey: result.data.DISCORD_PUBLIC_KEY.toLowerCase(),
      guildId: result.data.DISCORD_GUILD_ID,
      operationsRoleId: result.data.OPERATIONS_ROLE_ID,
    },
    gas: {
      webAppUrl: result.data.GAS_WEB_APP_URL,
      sharedSecret: result.data.GAS_SHARED_SECRET,
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
}
