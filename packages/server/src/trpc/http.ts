import { createHTTPHandler } from '@trpc/server/adapters/standalone';
import { appRouter } from './router.js';
import { createContext } from './context.js';
import { logger } from '../middleware/logging.js';

export const handler = createHTTPHandler({
  router: appRouter,
  createContext,
  onError({ error }) {
    logger.error({ err: error }, 'tRPC error');
  },
});

// Health check endpoint (non-tRPC)
export async function healthCheck(): Promise<Response> {
  return new Response(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }), {
    headers: { 'Content-Type': 'application/json' },
  });
}
