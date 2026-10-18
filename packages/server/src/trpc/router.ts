import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { router, publicProcedure, authedProcedure, adminProcedure } from './trpc.js';
import { database } from '../db/index.js';
import { nextId } from '@dune/shared';
import { handleLocalSync } from '../services/sync.js';
import { manifestForGame, removeGameFile } from '../services/manifest.js';
import { analyzeFilesAI, checkModelStatus, fetchModels } from '../services/ollama.js';
import { getHLTBTimes, bulkFetchHLTB } from '../services/hltb.js';
import { searchArt, autoMatchAll } from '../services/steamGridDB.js';
import { recordPlaytimeSession, getPlaytimeSummary, getRecentSessions, getTotalPlaytime } from '../services/playtime.js';
import { getGameAchievements, getAchievementSummary, getRecentUnlocks, handleSentinelWebhook } from '../services/achievements.js';
import { normalizeUrl, getGameRoot, listFilesInDir, validateGamePath } from '../utils/path.js';
import type { User } from '../types/index.js';
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

const userRole = z.enum(['admin', 'member']);

/** Members may only touch their own games; admins may touch anything. */
function assertGameAccess(user: User, gameName: string): string {
  const name = path.basename(gameName);
  if (!database.canAccessGame(user, name)) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'No access to this game' });
  }
  return name;
}

/** `undefined` = all owners (admin view); otherwise scope to that user. */
function ownerScope(user: User): string | undefined {
  return user.role === 'admin' ? undefined : user.id;
}

/** Stable, non-reversible id for a stored key hash (for list/remove). */
const shortKeyId = (hash: string): string => hash.slice(0, 12);


export const appRouter = router({
  games: {
    list: authedProcedure.query(async ({ ctx }) => {
      const games = database.getGamesForUser(ctx.user);
      return { success: true, games };
    }),

    get: authedProcedure
      .input(z.object({ id: z.number() }))
      .query(async ({ ctx, input }) => {
        const game = database.getGamesForUser(ctx.user).find(g => g.id === input.id);
        if (!game) throw new TRPCError({ code: 'NOT_FOUND', message: 'Game not found' });
        return { success: true, game };
      }),

    add: authedProcedure
      .input(gameInput)
      .mutation(async ({ ctx, input }) => {
        const games = await database.upsertGame({
          ...input,
          ownerId: ctx.user.id,
          id: nextId(),
          status: input.status || 'Pending Upload',
          lastSync: input.lastSync || 'Never',
          // undefined preserves an existing game's cover art on re-add;
          // upsertGame defaults it to '' for brand-new rows.
          thumbnail: input.thumbnail,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
        return { success: true, games };
      }),

    remove: authedProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ ctx, input }) => {
        const deleted = database.deleteGame(input.id, ownerScope(ctx.user));
        if (!deleted) throw new TRPCError({ code: 'NOT_FOUND', message: 'Game not found' });
        return { success: true };
      }),
  },

  sync: {
    test: authedProcedure
      .input(z.object({ url: z.string().url() }))
      .mutation(async ({ input }) => {
        try {
          const cleanUrl = normalizeUrl(input.url);
          const res = await axios.get(`${cleanUrl}/api/saves`, { timeout: 8000 });
          if (res.data.success) return { success: true, message: 'Connection successful' };
          return { success: false, message: 'Server returned error' };
        } catch (err: unknown) {
          return { success: false, message: err instanceof Error ? err.message : String(err) };
        }
      }),

    // Server-side folder scan into the shared library: admin-only.
    local: adminProcedure.mutation(async ({ ctx }) => {
      const result = await handleLocalSync(ctx.user.id);
      return result;
    }),

    manifest: authedProcedure
      .input(z.object({ game: z.string() }))
      .query(async ({ ctx, input }) => {
        const gameName = assertGameAccess(ctx.user, input.game);
        return { success: true, files: manifestForGame(gameName, ctx.user.id) };
      }),
  },

  files: {
    list: authedProcedure
      .input(z.object({ game: z.string() }))
      .query(async ({ ctx, input }) => {
        const gameName = assertGameAccess(ctx.user, input.game);
        const gameDir = getGameRoot(gameName, ctx.user.id);
        if (!fs.existsSync(gameDir)) return { success: true, files: [] };
        const files = listFilesInDir(gameDir);
        return { success: true, files };
      }),

    remove: authedProcedure
      .input(z.object({ game: z.string(), path: z.string() }))
      .mutation(async ({ ctx, input }) => {
        const gameName = assertGameAccess(ctx.user, input.game);
        try {
          validateGamePath(gameName, input.path, ctx.user.id);
        } catch {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid path' });
        }
        if (!removeGameFile(gameName, input.path, ctx.user.id)) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'File not found' });
        }
        return { success: true };
      }),

    versions: {
      list: authedProcedure
        .input(z.object({ game: z.string() }))
        .query(async ({ ctx, input }) => {
          const gameName = assertGameAccess(ctx.user, input.game);
          const versionsRoot = path.join(getGameRoot(gameName, ctx.user.id), '.versions');
          if (!fs.existsSync(versionsRoot)) return { success: true, versions: [] };
          const folders = fs.readdirSync(versionsRoot).filter(f => !isNaN(Number(f)));
          const versions = folders.map(f => ({
            id: f,
            timestamp: new Date(parseInt(f)).toISOString()
          })).sort((a, b) => parseInt(b.id) - parseInt(a.id));
          return { success: true, versions };
        }),

      files: authedProcedure
        .input(z.object({ game: z.string(), versionId: z.string().regex(/^\d+$/) }))
        .query(async ({ ctx, input }) => {
          const gameName = assertGameAccess(ctx.user, input.game);
          const versionDir = path.join(getGameRoot(gameName, ctx.user.id), '.versions', input.versionId);
          if (!fs.existsSync(versionDir)) return { success: true, files: [] };
          const files = listFilesInDir(versionDir);
          return { success: true, files };
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

    autoMatch: authedProcedure.mutation(async ({ ctx }) => {
      const settings = database.getSettings();
      const apiKey = settings.steamGridApiKey;
      if (!apiKey) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'SteamGridDB API key not configured' });
      const games = database.getGamesForUser(ctx.user);
      const matched = await autoMatchAll(apiKey, games);
      for (const m of matched) {
        const game = games.find(g => g.name === m.name);
        if (game && !game.thumbnail) {
          game.thumbnail = m.thumbnail;
          database.upsertGame(game);
        }
      }
      return { success: true, count: matched.length };
    }),

    set: authedProcedure
      .input(z.object({ gameName: z.string(), url: z.string().url() }))
      .mutation(async ({ ctx, input }) => {
        const game = database.getGamesForUser(ctx.user).find(g => g.name === input.gameName);
        if (!game) throw new TRPCError({ code: 'NOT_FOUND', message: 'Game not found' });
        game.thumbnail = input.url;
        database.upsertGame(game);
        return { success: true };
      }),
  },

  ai: {
    analyze: authedProcedure
      .input(z.object({
        gameName: z.string(),
        files: z.array(z.object({ path: z.string(), size: z.number(), category: z.string() }))
      }))
      .mutation(async ({ ctx, input }) => {
        const settings = database.getSettings();
        const endpoint = settings.ollamaEndpoint || 'http://ollama:11434';
        const model = settings.ollamaModel || 'phi4-mini:latest';
        const result = await analyzeFilesAI(endpoint, model, input.gameName, input.files);
        if (result.success && result.analysis) {
          const games = database.getGamesForUser(ctx.user);
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
      .input(z.object({ gameNames: z.array(z.string()).max(50) }))
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
      .mutation(async ({ ctx, input }) => {
        return recordPlaytimeSession(input.game, input.platform, input.sessionStart, input.sessionEnd, ctx.user.id);
      }),

    summary: authedProcedure
      .input(z.object({ game: z.string().optional() }))
      .query(async ({ ctx, input }) => {
        const summary = getPlaytimeSummary(input.game, ownerScope(ctx.user));
        return { success: true, summary };
      }),

    recent: authedProcedure
      .input(z.object({ limit: z.number().int().positive().max(100).default(50) }))
      .query(async ({ ctx, input }) => {
        const sessions = getRecentSessions(input.limit, ownerScope(ctx.user));
        return { success: true, sessions };
      }),

    total: authedProcedure.query(async ({ ctx }) => {
      const total = getTotalPlaytime(ownerScope(ctx.user));
      return { success: true, totalMinutes: total };
    }),
  },

  achievements: {
    get: authedProcedure
      .input(z.object({ game: z.string() }))
      .query(async ({ ctx, input }) => {
        const achievements = getGameAchievements(input.game, ownerScope(ctx.user));
        return { success: true, achievements };
      }),

    summary: authedProcedure
      .input(z.object({ game: z.string().optional() }))
      .query(async ({ ctx, input }) => {
        const summary = getAchievementSummary(input.game, ownerScope(ctx.user));
        return { success: true, summary };
      }),

    recent: authedProcedure
      .input(z.object({ limit: z.number().int().positive().max(100).default(20) }))
      .query(async ({ ctx, input }) => {
        const unlocks = getRecentUnlocks(input.limit, ownerScope(ctx.user));
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
      .mutation(async ({ ctx, input }) => {
        return handleSentinelWebhook(input.game, input.achievements, ctx.user.id);
      }),
  },

  localSources: {
    list: authedProcedure.query(async () => {
      return { success: true, sources: database.getLocalSources() };
    }),

    add: adminProcedure
      .input(z.object({ path: z.string() }))
      .mutation(async ({ input }) => {
        if (!fs.existsSync(input.path)) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Path does not exist' });
        const source = database.addLocalSource(input.path);
        return { success: true, source };
      }),

    remove: adminProcedure
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

    add: adminProcedure
      .input(z.object({ url: z.string().url() }))
      .mutation(async ({ input }) => {
        const server = database.addRemoteServer(input.url);
        return { success: true, server };
      }),

    remove: adminProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input }) => {
        const deleted = database.removeRemoteServer(input.id);
        if (!deleted) throw new TRPCError({ code: 'NOT_FOUND', message: 'Server not found' });
        return { success: true };
      }),
  },

  // Self-service key management for the calling user.
  apiKeys: {
    list: authedProcedure.query(async ({ ctx }) => {
      const keys = database.listUserKeys(ctx.user.id).map(k => ({
        id: shortKeyId(k.hash),
        description: k.description,
        createdAt: k.createdAt,
        masked: '****',
      }));
      return { success: true, keys };
    }),

    add: authedProcedure
      .input(z.object({ description: z.string().optional() }))
      .mutation(async ({ ctx, input }) => {
        const key = database.issueUserKey(ctx.user.id, input.description || '');
        // The plaintext key is returned exactly once, here.
        return { success: true, key };
      }),

    remove: authedProcedure
      .input(z.object({ id: z.string().min(1) }))
      .mutation(async ({ ctx, input }) => {
        const match = database.listUserKeys(ctx.user.id).find(k => shortKeyId(k.hash) === input.id);
        if (!match || !database.removeUserKeyByHash(match.hash)) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Key not found' });
        }
        return { success: true };
      }),
  },

  // User administration. `me` is available to any authenticated user; the rest
  // require an admin.
  users: {
    me: authedProcedure.query(async ({ ctx }) => {
      return { success: true, user: { id: ctx.user.id, name: ctx.user.name, role: ctx.user.role } };
    }),

    list: adminProcedure.query(async () => {
      const users = database.listUsers().map(u => ({
        id: u.id,
        name: u.name,
        role: u.role,
        createdAt: u.createdAt,
        keyCount: database.countUserKeys(u.id),
      }));
      return { success: true, users };
    }),

    create: adminProcedure
      .input(z.object({ name: z.string().min(1).max(64), role: userRole.default('member') }))
      .mutation(async ({ input }) => {
        if (database.getUserByName(input.name)) {
          throw new TRPCError({ code: 'CONFLICT', message: 'User name already exists' });
        }
        const user = database.createUser(input.name, input.role);
        const apiKey = database.issueUserKey(user.id, 'Initial key');
        return { success: true, user, apiKey };
      }),

    setRole: adminProcedure
      .input(z.object({ id: z.string(), role: userRole }))
      .mutation(async ({ input }) => {
        const target = database.getUserById(input.id);
        if (!target) throw new TRPCError({ code: 'NOT_FOUND', message: 'User not found' });
        if (target.role === 'admin' && input.role !== 'admin' && database.countAdmins() <= 1) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'Cannot demote the last admin' });
        }
        database.setUserRole(input.id, input.role);
        return { success: true };
      }),

    removeKey: adminProcedure
      .input(z.object({ id: z.string(), keyId: z.string().min(1) }))
      .mutation(async ({ input }) => {
        const match = database.listUserKeys(input.id).find(k => shortKeyId(k.hash) === input.keyId);
        if (!match || !database.removeUserKeyByHash(match.hash)) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Key not found' });
        }
        return { success: true };
      }),

    addKey: adminProcedure
      .input(z.object({ id: z.string(), description: z.string().optional() }))
      .mutation(async ({ input }) => {
        if (!database.getUserById(input.id)) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'User not found' });
        }
        const apiKey = database.issueUserKey(input.id, input.description || '');
        return { success: true, apiKey };
      }),

    remove: adminProcedure
      .input(z.object({ id: z.string() }))
      .mutation(async ({ input }) => {
        const target = database.getUserById(input.id);
        if (!target) throw new TRPCError({ code: 'NOT_FOUND', message: 'User not found' });
        if (target.role === 'admin' && database.countAdmins() <= 1) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'Cannot remove the last admin' });
        }
        database.deleteUser(input.id);
        return { success: true };
      }),
  },

  settings: {
    get: authedProcedure.query(async ({ ctx }) => {
      const settings = database.getSettings();
      // Third-party secret: the server performs SteamGridDB lookups itself, so
      // members never need the key — only admins get it in the clear.
      const isAdmin = ctx.user.role === 'admin';
      return {
        success: true,
        settings: {
          ...settings,
          apiKeys: settings.apiKeys.map(() => '****'),
          steamGridApiKey: isAdmin ? settings.steamGridApiKey : settings.steamGridApiKey ? '****' : '',
        },
      };
    }),

    update: adminProcedure
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
