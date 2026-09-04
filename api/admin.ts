import pino from 'pino';

import { loadConfig } from '../src/config.js';
import { GasRepository } from '../src/gas/repository.js';
import { handleAdminRequest } from '../src/web/server.js';

export const config = { maxDuration: 300 };

let runtime: ReturnType<typeof createRuntime> | undefined;

export default {
  fetch(request: Request): Promise<Response> {
    runtime ??= createRuntime();
    return handleAdminRequest(request, runtime.config, runtime.repository, runtime.logger);
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
