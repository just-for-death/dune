import { initTRPC, TRPCError } from '@trpc/server';
import type { TRPCContext } from './context.js';

const t = initTRPC.context<TRPCContext>().create();

export const router = t.router;
export const publicProcedure = t.procedure;

/**
 * Authenticated procedure. Requires a valid API key (see context.apiKeyValid).
 * The `health` procedure intentionally stays on publicProcedure.
 */
export const authedProcedure = t.procedure.use(async ({ ctx, next }) => {
  if (!ctx.apiKeyValid) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'API key required' });
  }
  return next({ ctx });
});
