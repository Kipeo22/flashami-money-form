import { Client, Events, GatewayIntentBits } from 'discord.js';
import pino from 'pino';

import { loadConfig } from './config.js';
import { registerInteractionHandler } from './discord/handler.js';
import { GasRepository } from './gas/repository.js';
import { startWebServer } from './web/server.js';

const config = loadConfig();
const logger = pino({ level: config.logLevel });
const repository = new GasRepository(config);
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, (readyClient) => {
  logger.info({ botUser: readyClient.user.tag }, 'Discord bot is ready');
});
client.on(Events.Error, (error) => logger.error({ err: error }, 'Discord client error'));
registerInteractionHandler(client, repository, logger);

await repository.initialize();
logger.info('GAS connection initialized');
await client.login(config.discord.token);
const webServer = await startWebServer(config, repository, logger);
logger.info(
  { host: config.web.host, port: config.web.port },
  'Event management web server is ready',
);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    logger.info({ signal }, 'shutting down');
    client.destroy();
    webServer.close(() => {
      process.exitCode = 0;
    });
  });
}
