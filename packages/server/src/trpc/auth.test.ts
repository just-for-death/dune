import { describe, it, expect } from 'vitest';
import { TRPCError } from '@trpc/server';
import { router, publicProcedure, authedProcedure } from './trpc.js';
import { createContext } from './context.js';
import { database } from '../db/index.js';

const baseCtx = {
  db: [],
  settings: database.getSettings(),
  userId: undefined,
} as const;

const testRouter = router({
  pub: publicProcedure.query(() => 'public-ok'),
  priv: authedProcedure.query(() => 'secret-ok'),
});

function caller(apiKeyValid: boolean) {
  return testRouter.createCaller({ ...baseCtx, apiKey: apiKeyValid ? 'k' : null, apiKeyValid });
}

describe('authedProcedure', () => {
  it('allows public procedures without a key', async () => {
    await expect(caller(false).pub()).resolves.toBe('public-ok');
  });

  it('rejects protected procedures without a valid key', async () => {
    await expect(caller(false).priv()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('allows protected procedures with a valid key', async () => {
    await expect(caller(true).priv()).resolves.toBe('secret-ok');
  });

  it('throws TRPCError with UNAUTHORIZED code', async () => {
    try {
      await caller(false).priv();
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(TRPCError);
      expect((e as TRPCError).code).toBe('UNAUTHORIZED');
    }
  });
});

describe('createContext key extraction', () => {
  const fakeReq = (headers: Record<string, string | string[]>, url = '/trpc/games.list') =>
    ({ headers, url }) as unknown as Parameters<typeof createContext>[0]['req'];

  it('yields null key when no header or query is present', async () => {
    const ctx = await createContext({ req: fakeReq({}), res: {} } as never);
    expect(ctx.apiKey).toBeNull();
    expect(ctx.apiKeyValid).toBe(false);
  });

  it('extracts x-api-key header but marks random keys invalid', async () => {
    const ctx = await createContext({
      req: fakeReq({ 'x-api-key': 'definitely-not-a-real-key-123' }),
      res: {},
    } as never);
    expect(ctx.apiKey).toBe('definitely-not-a-real-key-123');
    expect(ctx.apiKeyValid).toBe(false);
  });

  it('supports ?api_key= query fallback', async () => {
    const ctx = await createContext({
      req: fakeReq({}, '/trpc/games.list?api_key=nope'),
      res: {},
    } as never);
    expect(ctx.apiKey).toBe('nope');
    expect(ctx.apiKeyValid).toBe(false);
  });
});
