import pino from 'pino';
import { randomUUID } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';

const env = process.env.NODE_ENV || 'development';

/** Overridable sink for tests via createLogger(stream). */
export function createLogger(destination?: NodeJS.WritableStream) {
  const pretty =
    env !== 'production' && !process.env.VITEST
      ? pino.transport({
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:standard' },
        })
      : undefined;
  return pino(
    { level: process.env.LOG_LEVEL || 'info', base: { service: 'dune-server' } },
    destination ?? pretty,
  );
}

export const logger = createLogger();

export interface LoggedRequest extends Request {
  reqId?: string;
}

/**
 * Assigns a request ID and logs method/path/status/latency when the
 * response finishes. Register before all routes (incl. rate limiter)
 * so rejected requests are logged too. The `log` parameter exists for
 * tests; production callers omit it.
 */
export function requestLogger(
  req: LoggedRequest,
  res: Response,
  next: NextFunction,
  log: ReturnType<typeof createLogger> = logger,
): void {
  const reqId = randomUUID();
  req.reqId = reqId;
  const start = Date.now();
  res.on('finish', () => {
    log.info(
      { reqId, method: req.method, path: req.path, status: res.statusCode, latencyMs: Date.now() - start },
      'request',
    );
  });
  next();
}
