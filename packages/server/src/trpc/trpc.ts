import { initTRPC, TRPCError } from '@trpc/server';
import type { TRPCContext } from './context.js';
import type { User } from '../types/index.js';

const t = initTRPC.context<TRPCContext>().create();

export const router = t.router;
export const publicProcedure = t.procedure;

/**
 * Authenticated procedure. Requires a valid API key (see context.apiKeyValid)
 * and narrows `ctx.user` to a non-null User for downstream handlers.
 * The `health` procedure intentionally stays on publicProcedure.
 */
export const authedProcedure = t.procedure.use(async ({ ctx, next }) => {
  const user = ctx.user;
  if (!ctx.apiKeyValid || !user) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'API key required' });
  }
  return next({ ctx: { ...ctx, user } });
});

/** Authenticated + `role === 'admin'`. */
export const adminProcedure = authedProcedure.use(async ({ ctx, next }) => {
  if (ctx.user.role !== 'admin') {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Admin privileges required' });
  }
  return next({ ctx });
});

export type { User };
