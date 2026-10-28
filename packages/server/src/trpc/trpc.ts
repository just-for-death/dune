import { initTRPC, TRPCError } from '@trpc/server';
import type { TRPCContext } from './context.js';
import type { User } from '../types/index.js';
import { ApiError } from '../utils/apiError.js';

type TRPCCode = ConstructorParameters<typeof TRPCError>[0]['code'];
const STATUS_TO_TRPC: Record<number, TRPCCode> = {
  400: 'BAD_REQUEST', 401: 'UNAUTHORIZED', 403: 'FORBIDDEN', 404: 'NOT_FOUND',
  409: 'CONFLICT', 413: 'PAYLOAD_TOO_LARGE', 429: 'TOO_MANY_REQUESTS',
};

/**
 * The structured app code behind a tRPC error: an ApiError cause, or a zod
 * issue that carries `params.code` (e.g. LAUNCH_FIELD_NOT_ALLOWED).
 */
function apiCodeOf(error: TRPCError): string | null {
  const cause = error.cause as unknown;
  if (cause instanceof ApiError) return cause.code;
  const issues = (cause as { issues?: Array<{ params?: { code?: unknown } }> } | undefined)?.issues;
  const tagged = Array.isArray(issues) ? issues.find((i) => typeof i.params?.code === 'string') : undefined;
  return tagged ? (tagged.params!.code as string) : null;
}

const t = initTRPC.context<TRPCContext>().create({
  // Same codes as REST `{ error, code }`, exposed as `error.data.code`
  // (e.g. INVALID_VERSION_ID, DOT_SEGMENT, GAME_NOT_FOUND, LAUNCH_FIELD_NOT_ALLOWED).
  errorFormatter({ shape, error }) {
    // data.code = the app code when there is one, else tRPC's own code.
    return { ...shape, data: { ...shape.data, code: apiCodeOf(error) ?? shape.data.code } };
  },
});

/** Map a thrown ApiError (PathRuleError, LaunchFieldError, ...) to its tRPC code. */
const apiErrors = t.middleware(async ({ next }) => {
  const result = await next();
  if (!result.ok) {
    const cause = result.error.cause;
    if (cause instanceof ApiError && result.error.code === 'INTERNAL_SERVER_ERROR') {
      throw new TRPCError({ code: STATUS_TO_TRPC[cause.status] ?? 'BAD_REQUEST', message: cause.message, cause });
    }
  }
  return result;
});

export const router = t.router;
export const publicProcedure = t.procedure.use(apiErrors);

/**
 * Authenticated procedure. Requires a valid API key (see context.apiKeyValid)
 * and narrows `ctx.user` to a non-null User for downstream handlers.
 * The `health` procedure intentionally stays on publicProcedure.
 */
export const authedProcedure = publicProcedure.use(async ({ ctx, next }) => {
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
