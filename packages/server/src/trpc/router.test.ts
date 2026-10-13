import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('axios');
import axios from 'axios';

// Isolate ALL side effects BEFORE importing app modules (static imports hoist).
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dune-router-test-'));
process.env.API_KEY_SECRET = 'router-test-secret-0123456789abcdef';

const postMock = vi.mocked(axios.post);
const getMock = vi.mocked(axios.get);

const { database } = await import('../db/index.js');
const { appRouter } = await import('./router.js');

const RAW_KEY = 'router-test-key-abc123';

function ctx(valid = true) {
  return {
    db: database.getGames(),
    settings: database.getSettings(),
    apiKey: valid ? RAW_KEY : null,
    apiKeyValid: valid,
  };
}

beforeEach(() => {
  postMock.mockReset();
  getMock.mockReset();
  // Default: network is down. Individual tests opt into mocked responses.
  postMock.mockRejectedValue(new Error('offline'));
  getMock.mockRejectedValue(new Error('offline'));
});

const TMP = process.env.DATA_DIR as string;

afterAll(() => {
  delete process.env.DATA_DIR;
  delete process.env.API_KEY_SECRET;
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('auth gate (every domain)', () => {
  it('rejects representative procedures without a valid key', async () => {
    const bad = appRouter.createCaller(ctx(false));
    await expect(bad.games.list()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(bad.playtime.total()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(bad.achievements.summary({})).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(bad.settings.get()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(bad.files.list({ game: 'x' })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(bad.hltb.get({ gameName: 'x' })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(bad.ai.health()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(bad.art.search({ query: 'x' })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(bad.localSources.list()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(bad.remoteServers.list()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(bad.apiKeys.list()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(bad.sync.local()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('keeps health public', async () => {
    const bad = appRouter.createCaller(ctx(false));
    const res = await bad.health();
    expect(res.status).toBe('ok');
  });
});

describe('games contract', () => {
  it('add → get → list → remove round-trips', async () => {
    const c = appRouter.createCaller(ctx());
    const added = await c.games.add({ name: 'Contract Game' });
    expect(added.success).toBe(true);
    const id = (added.games as { id: number }).id;

    const got = await c.games.get({ id });
    expect(got.game.name).toBe('Contract Game');

    const list = await c.games.list();
    expect(list.games.some(g => g.id === id)).toBe(true);

    await c.games.remove({ id });
    await expect(c.games.get({ id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('rejects unknown ids and invalid input', async () => {
    const c = appRouter.createCaller(ctx());
    await expect(c.games.get({ id: -999 })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(c.games.remove({ id: -999 })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(c.games.add({ name: '' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(c.games.add({} as never)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});

describe('settings + apiKeys contract', () => {
  it('masks stored keys and persists updates', async () => {
    const c = appRouter.createCaller(ctx());
    database.addApiKey(RAW_KEY);
    const got = await c.settings.get();
    expect(JSON.stringify(got.settings)).not.toContain(RAW_KEY);

    await c.settings.update({ maxVersions: 7 });
    expect(database.getSettings().maxVersions).toBe(7);
    await expect(c.settings.update({ maxVersions: 0 })).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    const keys = await c.apiKeys.list();
    expect(keys.success).toBe(true);
    await expect(c.apiKeys.add({ key: '' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(database.removeApiKey(RAW_KEY)).toBe(true);
  });
});

describe('playtime contract', () => {
  it('records and summarizes sessions', async () => {
    const c = appRouter.createCaller(ctx());
    const r = await c.playtime.record({
      game: 'Contract Game',
      platform: 'test',
      sessionStart: '2024-01-01T10:00:00.000Z',
      sessionEnd: '2024-01-01T11:30:00.000Z',
    });
    expect(r.success).toBe(true);

    const s = await c.playtime.summary({ game: 'Contract Game' });
    expect(s.summary).toHaveLength(1);
    expect(s.summary[0].totalMinutes).toBe(90);

    const total = await c.playtime.total();
    expect(total.totalMinutes).toBeGreaterThanOrEqual(90);
  });

  it('rejects bad input via Zod and bad ranges via service', async () => {
    const c = appRouter.createCaller(ctx());
    await expect(
      c.playtime.record({ game: 'g', platform: 'p', sessionStart: 'nope', sessionEnd: '2024-01-01T10:00:00.000Z' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    const r = await c.playtime.record({
      game: 'g', platform: 'p',
      sessionStart: '2024-01-01T12:00:00.000Z', sessionEnd: '2024-01-01T10:00:00.000Z',
    });
    expect(r.success).toBe(false);
  });
});

describe('achievements contract', () => {
  it('webhook upsert → get → summary math', async () => {
    const c = appRouter.createCaller(ctx());
    const w = await c.achievements.sentinelWebhook({
      game: 'Contract Game',
      achievements: [
        { apiName: 'A1', displayName: 'One', unlocked: true, unlockTime: '2024-01-01T10:00:00.000Z' },
        { apiName: 'A2', displayName: 'Two', unlocked: false },
      ],
    });
    expect(w).toEqual({ success: true, count: 2 });

    const got = await c.achievements.get({ game: 'Contract Game' });
    expect(got.achievements).toHaveLength(2);

    const summary = await c.achievements.summary({ game: 'Contract Game' });
    expect(summary.summary[0]).toMatchObject({ total: 2, unlocked: 1, percentage: 50 });
  });
});

describe('files + versions contract', () => {
  it('returns empty collections for unknown games', async () => {
    const c = appRouter.createCaller(ctx());
    expect((await c.files.list({ game: 'Nope' })).files).toEqual([]);
    expect((await c.files.versions.list({ game: 'Nope' })).versions).toEqual([]);
    expect((await c.files.versions.files({ game: 'Nope', versionId: '1' })).files).toEqual([]);
  });

  it('stub download endpoints stay stable', async () => {
    const c = appRouter.createCaller(ctx());
    expect((await c.files.download({ game: 'x', path: 'y' })).success).toBe(true);
    expect((await c.sync.export()).success).toBe(true);
  });
});

describe('localSources + remoteServers contract', () => {
  it('validates paths and urls', async () => {
    const c = appRouter.createCaller(ctx());
    await expect(c.localSources.add({ path: '/nonexistent-xyz' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    const src = await c.localSources.add({ path: process.env.DATA_DIR as string });
    expect(src.success).toBe(true);
    await expect(c.localSources.remove({ id: -1 })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await c.localSources.remove({ id: src.source.id })).success).toBe(true);

    await expect(c.remoteServers.add({ url: 'not-a-url' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    const srv = await c.remoteServers.add({ url: 'http://backup:3030' });
    expect(srv.success).toBe(true);
    await expect(c.remoteServers.remove({ id: -1 })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await c.remoteServers.remove({ id: srv.server.id })).success).toBe(true);
  });
});

describe('ai + art + hltb contract (offline)', () => {
  it('ai.analyze fails closed without network', async () => {
    const c = appRouter.createCaller(ctx());
    const r = await c.ai.analyze({ gameName: 'g', files: [{ path: 'a.sav', size: 10, category: 'Save' }] });
    expect(r.success).toBe(false);
  });

  it('ai.analyze succeeds with mocked model and persists to the game', async () => {
    const c = appRouter.createCaller(ctx());
    await c.games.add({ name: 'AI Game' });
    postMock.mockResolvedValue({
      data: { response: '{"a.sav":{"category":"Save","description":"main"}}' },
    });
    const r = await c.ai.analyze({ gameName: 'AI Game', files: [{ path: 'a.sav', size: 10, category: 'Save' }] });
    expect(r.success).toBe(true);
    const got = await c.games.get({ id: (await c.games.list()).games.find(g => g.name === 'AI Game')!.id });
    expect(got.game.analysis).toMatchObject({ 'a.sav': { category: 'Save' } });
  });

  it('ai.models + health read mocked ollama', async () => {
    const c = appRouter.createCaller(ctx());
    getMock.mockResolvedValue({ data: { models: [{ name: 'phi4-mini:latest' }] } });
    const models = await c.ai.models({ endpoint: 'http://ollama:11434' });
    expect(models.models).toContain('phi4-mini:latest');
    const health = await c.ai.health();
    expect(health).toMatchObject({ success: true, exists: true });
    await expect(c.ai.models({ endpoint: 'notaurl' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('art.search requires a key; with key + mocked API returns art', async () => {
    const c = appRouter.createCaller(ctx());
    await expect(c.art.search({ query: 'x' })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await c.settings.update({ steamGridApiKey: 'sgdb-test' });
    getMock.mockImplementation(async (url: string) => {
      if (String(url).includes('autocomplete')) return { data: { success: true, data: [{ id: 7, name: 'G' }] } };
      return { data: { success: true, data: [{ url: 'http://img/y.jpg' }] } };
    });
    const r = await c.art.search({ query: 'G' });
    expect(r.results).toEqual(['http://img/y.jpg']);
    await c.settings.update({ steamGridApiKey: '' });
  });

  it('hltb serves cache without network and fails closed offline', async () => {
    const c = appRouter.createCaller(ctx());
    const { writeCache } = await import('../services/hltb.js');
    writeCache('Cached Contract Game', { mainStory: 60, mainExtra: 90, completionist: 120 });
    const hit = await c.hltb.get({ gameName: 'Cached Contract Game' });
    expect(hit).toMatchObject({ success: true });
    expect(postMock).not.toHaveBeenCalled();

    const miss = await c.hltb.get({ gameName: 'Definitely Not A Real Game 12345' });
    expect(miss.success).toBe(false);
  });
});
