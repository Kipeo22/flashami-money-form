import { waitUntil } from '@vercel/functions';
import pino from 'pino';

import { loadConfig } from '../src/config.js';
import { handleDiscordInteraction } from '../src/discord/handler.js';
import { GasRepository } from '../src/gas/repository.js';

export const config = { maxDuration: 300 };

let runtime: ReturnType<typeof createRuntime> | undefined;

export default {
  fetch(request: Request): Promise<Response> {
    runtime ??= createRuntime();
    return handleDiscordInteraction(request, {
      ...runtime,
      deferTask: waitUntil,
    });
  },
};

function createRuntime() {
  const config = loadConfig();
  return {
    config,
    repository: new GasRepository(config),
    logger: pino({ level: config.logLevel }),
  };
}
