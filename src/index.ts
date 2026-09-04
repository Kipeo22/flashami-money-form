import { createServer, type IncomingMessage } from 'node:http';

import pino from 'pino';

import { loadConfig } from './config.js';
import { handleDiscordInteraction } from './discord/handler.js';
import { GasRepository } from './gas/repository.js';
import { handleAdminRequest } from './web/server.js';

const config = loadConfig();
const logger = pino({ level: config.logLevel });
const repository = new GasRepository(config);

const server = createServer(async (incoming, outgoing) => {
  try {
    const request = await toRequest(incoming, config.web.host, config.web.port);
    const path = new URL(request.url).pathname;
    const response =
      path === '/health' || path === '/api/health'
        ? new Response('ok', { headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
        : path === '/api/interactions'
          ? await handleDiscordInteraction(request, {
              config,
              repository,
              logger,
              deferTask: (task) => {
                void task.catch((error: unknown) => logger.error({ err: error }, 'task failed'));
              },
            })
          : await handleAdminRequest(request, config, repository, logger);

    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    logger.error({ err: error }, 'local web request failed');
    outgoing.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end('error');
  }
});

server.listen(config.web.port, config.web.host, () => {
  logger.info(
    { host: config.web.host, port: config.web.port },
    'Vercel-compatible local server is ready',
  );
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    logger.info({ signal }, 'shutting down');
    server.close(() => {
      process.exitCode = 0;
    });
  });
}

async function toRequest(request: IncomingMessage, host: string, port: number): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const chunk of request)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const method = request.method ?? 'GET';
  const body = Buffer.concat(chunks);
  const init: RequestInit = {
    method,
    headers: request.headers as HeadersInit,
  };
  if (method !== 'GET' && method !== 'HEAD') init.body = body;
  return new Request(`http://${host}:${port}${request.url ?? '/'}`, init);
}
