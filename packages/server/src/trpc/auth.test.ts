import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TRPCError } from '@trpc/server';
import type { User } from '../types/index.js';

// Isolate ALL side effects BEFORE importing app modules (static imports hoist).
const SETUP_DATA_DIR = process.env.DATA_DIR as string; // temp dir from src/test/setup.ts (DUN-005)
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dune-auth-test-'));
process.env.API_KEY_SECRET = 'auth-test-secret-0123456789abcdef';

const { router, publicProcedure, authedProcedure, adminProcedure } = await import('./trpc.js');
const { createContext } = await import('./context.js');
const { database } = await import('../db/index.js');

const TMP = process.env.DATA_DIR as string;

afterAll(() => {
  process.env.DATA_DIR = SETUP_DATA_DIR; // restore the temp dir, never unset (DUN-005)
  delete process.env.API_KEY_SECRET;
  fs.rmSync(TMP, { recursive: true, force: true });
});

const baseUser: User = { id: 'usr_test', name: 'tester', role: 'member', createdAt: '', updatedAt: '' };

const baseCtx = {
  db: [],
  settings: database.getSettings(),
  apiKey: null as string | null,
  apiKeyValid: false,
  user: null as User | null,
};

const testRouter = router({
  pub: publicProcedure.query(() => 'public-ok'),
  priv: authedProcedure.query(({ ctx }) => `secret-ok:${ctx.user.role}`),
  admin: adminProcedure.query(() => 'admin-ok'),
});

function caller(valid: boolean, role: User['role'] = 'admin') {
  return testRouter.createCaller({
    ...baseCtx,
    apiKey: valid ? 'k' : null,
    apiKeyValid: valid,
    user: valid ? { ...baseUser, role } : null,
  });
}

describe('authedProcedure', () => {
  it('allows public procedures without a key', async () => {
    await expect(caller(false).pub()).resolves.toBe('public-ok');
  });

  it('rejects protected procedures without a valid key', async () => {
    await expect(caller(false).priv()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('allows protected procedures with a valid key and narrows the user', async () => {
    await expect(caller(true).priv()).resolves.toBe('secret-ok:admin');
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

describe('adminProcedure', () => {
  it('rejects members and unauthenticated callers', async () => {
    await expect(caller(true, 'member').admin()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller(false).admin()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('allows admins', async () => {
    await expect(caller(true, 'admin').admin()).resolves.toBe('admin-ok');
  });
});

describe('createContext key extraction', () => {
  const fakeReq = (headers: Record<string, string | string[]>, url = '/trpc/games.list') =>
    ({ headers, url }) as unknown as Parameters<typeof createContext>[0]['req'];

  it('yields null key when no header or query is present', async () => {
    const ctx = await createContext({ req: fakeReq({}), res: {} } as never);
    expect(ctx.apiKey).toBeNull();
    expect(ctx.apiKeyValid).toBe(false);
    expect(ctx.user).toBeNull();
  });

  it('extracts x-api-key header but marks random keys invalid', async () => {
    const ctx = await createContext({
      req: fakeReq({ 'x-api-key': 'definitely-not-a-real-key-123' }),
      res: {},
    } as never);
    expect(ctx.apiKey).toBe('definitely-not-a-real-key-123');
    expect(ctx.apiKeyValid).toBe(false);
  });

  it('ignores a ?api_key= query value (header only, DUN-102)', async () => {
    const ctx = await createContext({
      req: fakeReq({}, '/trpc/games.list?api_key=nope'),
      res: {},
    } as never);
    expect(ctx.apiKey).toBeNull();
    expect(ctx.apiKeyValid).toBe(false);
  });

  it('resolves a real key to its user', async () => {
    const admin = database.listUsers()[0];
    const raw = database.issueUserKey(admin.id, 'auth-test');
    const ctx = await createContext({
      req: fakeReq({ 'x-api-key': raw }),
      res: {},
    } as never);
    expect(ctx.apiKeyValid).toBe(true);
    expect(ctx.user?.id).toBe(admin.id);
    expect(ctx.user?.role).toBe('admin');
  });
});
