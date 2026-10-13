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
