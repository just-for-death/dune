import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { router, publicProcedure, authedProcedure } from './trpc.js';
import { database } from '../db/index.js';
import { handleUploadFile, handleLocalSync } from '../services/sync.js';
import { analyzeFilesAI, checkModelStatus, fetchModels } from '../services/ollama.js';
import { getHLTBTimes, bulkFetchHLTB } from '../services/hltb.js';
import { searchArt, autoMatchAll } from '../services/steamGridDB.js';
import { recordPlaytimeSession, getPlaytimeSummary, getRecentSessions, getTotalPlaytime } from '../services/playtime.js';
import { upsertAchievements, getGameAchievements, getAchievementSummary, getRecentUnlocks, handleSentinelWebhook } from '../services/achievements.js';
import { triggerRemoteSync } from '../services/remoteSync.js';
import { normalizeUrl, getGameRoot, validateGamePath, listFilesInDir } from '../utils/path.js';
import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';

const gameInput = z.object({
  name: z.string().min(1),
  winPath: z.string().optional(),
  linPath: z.string().optional(),
  status: z.enum(['In Sync', 'Pending Upload', 'Error']).optional(),
  lastSync: z.string().optional(),
  thumbnail: z.string().optional(),
});


export const appRouter = router({
  games: {
    list: authedProcedure.query(async () => {
      const games = database.getGames();
      return { success: true, games };
    }),

    get: authedProcedure
      .input(z.object({ id: z.number() }))
      .query(async ({ input }) => {
        const games = database.getGames();
        const game = games.find(g => g.id === input.id);
        if (!game) throw new TRPCError({ code: 'NOT_FOUND', message: 'Game not found' });
        return { success: true, game };
      }),

    add: authedProcedure
      .input(gameInput)
      .mutation(async ({ input }) => {
        const games = await database.upsertGame({
          ...input,
          id: Date.now() + Math.random(),
          status: input.status || 'Pending Upload',
          lastSync: input.lastSync || 'Never',
          thumbnail: input.thumbnail || '',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
        return { success: true, games };
      }),

    remove: authedProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input }) => {
        const deleted = database.deleteGame(input.id);
        if (!deleted) throw new TRPCError({ code: 'NOT_FOUND', message: 'Game not found' });
        return { success: true };
      }),
  },

  sync: {
    export: authedProcedure.mutation(async () => {
      return { success: true, message: 'Use REST endpoint for file download' };
    }),

    push: authedProcedure
      .input(z.object({ url: z.string().url() }))
      .mutation(async () => {
        return { success: true, message: 'Use REST endpoint for file upload with streaming' };
      }),

    restore: authedProcedure
      .input(z.object({ url: z.string().url() }))
      .mutation(async ({ input }) => {
        return { success: true, message: 'Use REST endpoint for restore' };
      }),

    test: authedProcedure
      .input(z.object({ url: z.string().url() }))
      .mutation(async ({ input }) => {
        try {
          const cleanUrl = normalizeUrl(input.url);
          const res = await axios.get(`${cleanUrl}/api/saves`);
          if (res.data.success) return { success: true, message: 'Connection successful' };
          return { success: false, message: 'Server returned error' };
        } catch (err: any) {
          return { success: false, message: err.message };
        }
      }),

    local: authedProcedure.mutation(async () => {
      const result = await handleLocalSync();
      return result;
    }),
  },

  files: {
    list: authedProcedure
      .input(z.object({ game: z.string() }))
      .query(async ({ input }) => {
        const gameName = path.basename(input.game);
        const gameDir = getGameRoot(gameName);
        if (!fs.existsSync(gameDir)) return { success: true, files: [] };
        const files = listFilesInDir(gameDir);
        return { success: true, files };
      }),

    download: authedProcedure
      .input(z.object({ game: z.string(), path: z.string() }))
      .query(async ({ input }) => {
        return { success: true, message: 'Use REST endpoint for file download' };
      }),

    versions: {
      list: authedProcedure
        .input(z.object({ game: z.string() }))
        .query(async ({ input }) => {
          const gameName = path.basename(input.game);
          const versionsRoot = path.join(getGameRoot(gameName), '.versions');
          if (!fs.existsSync(versionsRoot)) return { success: true, versions: [] };
          const folders = fs.readdirSync(versionsRoot).filter(f => !isNaN(Number(f)));
          const versions = folders.map(f => ({
            id: f,
            timestamp: new Date(parseInt(f)).toISOString()
          })).sort((a, b) => parseInt(b.id) - parseInt(a.id));
          return { success: true, versions };
        }),

      files: authedProcedure
        .input(z.object({ game: z.string(), versionId: z.string() }))
        .query(async ({ input }) => {
          const gameName = path.basename(input.game);
          const versionDir = path.join(getGameRoot(gameName), '.versions', input.versionId);
          if (!fs.existsSync(versionDir)) return { success: true, files: [] };
          const files = listFilesInDir(versionDir);
          return { success: true, files };
        }),

      download: authedProcedure
        .input(z.object({ game: z.string(), versionId: z.string(), path: z.string() }))
        .query(async ({ input }) => {
          return { success: true, message: 'Use REST endpoint for version file download' };
        }),
    },
  },

  art: {
    search: authedProcedure
      .input(z.object({ query: z.string().min(1) }))
      .query(async ({ input }) => {
        const settings = database.getSettings();
        const apiKey = settings.steamGridApiKey;
        if (!apiKey) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'SteamGridDB API key not configured' });
        const result = await searchArt(apiKey, input.query);
        return result;
      }),

    autoMatch: authedProcedure.mutation(async () => {
      const settings = database.getSettings();
      const apiKey = settings.steamGridApiKey;
      if (!apiKey) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'SteamGridDB API key not configured' });
      const games = database.getGames();
      const count = await autoMatchAll(apiKey, games);
      return { success: true, count };
    }),

    set: authedProcedure
      .input(z.object({ gameName: z.string(), url: z.string().url() }))
      .mutation(async ({ input }) => {
        const games = database.getGames();
        const game = games.find(g => g.name === input.gameName);
        if (!game) throw new TRPCError({ code: 'NOT_FOUND', message: 'Game not found' });
        game.thumbnail = input.url;
        database.upsertGame(game);
        return { success: true };
      }),

    upload: authedProcedure
      .input(z.object({ gameName: z.string(), file: z.string() }))
      .mutation(async ({ input }) => {
        return { success: true, message: 'Use REST endpoint for file upload' };
      }),
  },

  ai: {
    analyze: authedProcedure
      .input(z.object({
        gameName: z.string(),
        files: z.array(z.object({ path: z.string(), size: z.number(), category: z.string() }))
      }))
      .mutation(async ({ input }) => {
        const settings = database.getSettings();
        const endpoint = settings.ollamaEndpoint || 'http://ollama:11434';
        const model = settings.ollamaModel || 'phi4-mini:latest';
        const result = await analyzeFilesAI(endpoint, model, input.gameName, input.files);
        if (result.success && result.analysis) {
          const games = database.getGames();
          const gameIdx = games.findIndex(g => g.name.toLowerCase() === input.gameName.toLowerCase());
          if (gameIdx !== -1) {
            games[gameIdx].analysis = result.analysis;
            database.upsertGame(games[gameIdx]);
          }
        }
        return result;
      }),

    health: authedProcedure.query(async () => {
      const settings = database.getSettings();
      const endpoint = settings.ollamaEndpoint || 'http://ollama:11434';
      const model = settings.ollamaModel || 'phi4-mini:latest';
      return await checkModelStatus(endpoint, model);
    }),

    models: authedProcedure
      .input(z.object({ endpoint: z.string().url() }))
      .query(async ({ input }) => {
        return await fetchModels(input.endpoint);
      }),
  },

  hltb: {
    get: authedProcedure
      .input(z.object({ gameName: z.string() }))
      .query(async ({ input }) => {
        return await getHLTBTimes(input.gameName);
      }),

    bulk: authedProcedure
      .input(z.object({ gameNames: z.array(z.string()) }))
      .query(async ({ input }) => {
        const results = await bulkFetchHLTB(input.gameNames);
        return { success: true, times: Object.fromEntries(results) };
      }),
  },

  playtime: {
    record: authedProcedure
      .input(z.object({
        game: z.string(),
        platform: z.string(),
        sessionStart: z.string().datetime(),
        sessionEnd: z.string().datetime(),
      }))
      .mutation(async ({ input }) => {
        return recordPlaytimeSession(input.game, input.platform, input.sessionStart, input.sessionEnd);
      }),

    summary: authedProcedure
      .input(z.object({ game: z.string().optional() }))
      .query(async ({ input }) => {
        const summary = getPlaytimeSummary(input.game);
        return { success: true, summary };
      }),

    recent: authedProcedure
      .input(z.object({ limit: z.number().int().positive().max(100).default(50) }))
      .query(async ({ input }) => {
        const sessions = getRecentSessions(input.limit);
        return { success: true, sessions };
      }),

    total: authedProcedure.query(async () => {
      const total = getTotalPlaytime();
      return { success: true, totalMinutes: total };
    }),
  },

  achievements: {
    get: authedProcedure
      .input(z.object({ game: z.string() }))
      .query(async ({ input }) => {
        const achievements = getGameAchievements(input.game);
        return { success: true, achievements };
      }),

    summary: authedProcedure
      .input(z.object({ game: z.string().optional() }))
      .query(async ({ input }) => {
        const summary = getAchievementSummary(input.game);
        return { success: true, summary };
      }),

    recent: authedProcedure
      .input(z.object({ limit: z.number().int().positive().max(100).default(20) }))
      .query(async ({ input }) => {
        const unlocks = getRecentUnlocks(input.limit);
        return { success: true, unlocks };
      }),

    sentinelWebhook: authedProcedure
      .input(z.object({
        game: z.string(),
        achievements: z.array(z.object({
          apiName: z.string(),
          displayName: z.string(),
          description: z.string().optional(),
          unlocked: z.boolean(),
          unlockTime: z.string().optional().nullable(),
          rarity: z.number().optional(),
          hidden: z.boolean().optional(),
        }))
      }))
      .mutation(async ({ input }) => {
        return handleSentinelWebhook(input.game, input.achievements);
      }),
  },

  localSources: {
    list: authedProcedure.query(async () => {
      return { success: true, sources: database.getLocalSources() };
    }),

    add: authedProcedure
      .input(z.object({ path: z.string() }))
      .mutation(async ({ input }) => {
        if (!fs.existsSync(input.path)) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Path does not exist' });
        const source = database.addLocalSource(input.path);
        return { success: true, source };
      }),

    remove: authedProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input }) => {
        const deleted = database.removeLocalSource(input.id);
        if (!deleted) throw new TRPCError({ code: 'NOT_FOUND', message: 'Source not found' });
        return { success: true };
      }),
  },

  remoteServers: {
    list: authedProcedure.query(async () => {
      return { success: true, servers: database.getRemoteServers() };
    }),

    add: authedProcedure
      .input(z.object({ url: z.string().url() }))
      .mutation(async ({ input }) => {
        const server = database.addRemoteServer(input.url);
        return { success: true, server };
      }),

    remove: authedProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input }) => {
        const deleted = database.removeRemoteServer(input.id);
        if (!deleted) throw new TRPCError({ code: 'NOT_FOUND', message: 'Server not found' });
        return { success: true };
      }),
  },

  apiKeys: {
    list: authedProcedure.query(async () => {
      return { success: true, keys: database.getApiKeys().map(k => k.replace(/./g, '*')) };
    }),

    add: authedProcedure
      .input(z.object({ key: z.string().min(1), description: z.string().optional() }))
      .mutation(async ({ input }) => {
        database.addApiKey(input.key, input.description);
        return { success: true };
      }),

    remove: authedProcedure
      .input(z.object({ key: z.string() }))
      .mutation(async ({ input }) => {
        const deleted = database.removeApiKey(input.key);
        if (!deleted) throw new TRPCError({ code: 'NOT_FOUND', message: 'Key not found' });
        return { success: true };
      }),
  },

  settings: {
    get: authedProcedure.query(async () => {
      const settings = database.getSettings();
      return { success: true, settings: { ...settings, apiKeys: settings.apiKeys.map(() => '****') } };
    }),

    update: authedProcedure
      .input(z.object({
        maxVersions: z.number().int().positive().max(100).optional(),
        steamGridApiKey: z.string().optional(),
        ollamaEndpoint: z.string().url().optional(),
        ollamaModel: z.string().optional(),
        autoSyncEnabled: z.boolean().optional(),
        autoSyncFreq: z.enum(['never', '1h', '6h', '24h']).optional(),
      }))
      .mutation(async ({ input }) => {
        const current = database.getSettings();
        const merged = { ...current, ...input };
        database.saveSettings(merged);
        return { success: true };
      }),
  },

  health: publicProcedure.query(async () => {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }),
});

export type AppRouter = typeof appRouter;
