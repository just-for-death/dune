import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { router, publicProcedure, authedProcedure, adminProcedure } from './trpc.js';
import { database } from '../db/index.js';
import { handleLocalSync } from '../services/sync.js';
import { manifestForGame, removeGameFile } from '../services/manifest.js';
import { analyzeFilesAI, checkModelStatus, fetchModels } from '../services/ollama.js';
import { getHLTBTimes, bulkFetchHLTB } from '../services/hltb.js';
import { searchArt, autoMatchAll } from '../services/steamGridDB.js';
import { withSteamGridKey, steamGridKeyStatus, setSteamGridKey, clearSteamGridKey } from '../services/providerKeys.js';
import { recordPlaytimeSession, getPlaytimeSummary, getRecentSessions, getTotalPlaytime } from '../services/playtime.js';
import { getGameAchievements, getAchievementSummary, getRecentUnlocks, handleSentinelWebhook } from '../services/achievements.js';
import {
  normalizeUrl, getGameRoot, listFilesInDir, resolveGameSubdir, requireGameTitle, PathRuleError,
} from '../utils/path.js';

/** Upload snapshot folder ids: digits only (see sync.ts safeVersionId). */
const UPLOAD_VERSION_ID = /^\d{1,20}$/;
import { gameNotFound, findLaunchFields, LaunchFieldError } from '../utils/apiError.js';
import { validateRelativeSavePath } from '@dune/shared/pathRules';
import { VERSION_DIR_ID } from '../services/saveVersions.js';
import type { Game, User } from '../types/index.js';
import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';

// DUN-061: launch/exec fields (executable, args, env, cwd, wine*/proton*...)
// are device-local. Zod would silently strip unknown keys, so they are
// rejected explicitly before parsing: BAD_REQUEST, data.code LAUNCH_FIELD_NOT_ALLOWED.
// winPath/linPath are no longer accepted (the server never stores them).
const gameInput = z.unknown().superRefine((raw, ctx) => {
  const found = findLaunchFields(raw);
  if (found.length > 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: new LaunchFieldError(found).message, params: { code: 'LAUNCH_FIELD_NOT_ALLOWED' } });
  }
}).pipe(z.object({
  name: z.string().min(1),
  status: z.enum(['In Sync', 'Pending Upload', 'Error']).optional(),
  lastSync: z.string().optional(),
  thumbnail: z.string().optional(),
}).strict());

const userRole = z.enum(['admin', 'member']);

/**
 * DUN-087/088: the caller's own game with this title (validated,
 * case-insensitive). Admins address another user's game only with an explicit
 * `owner`. Unknown / other users' titles are NOT_FOUND (GAME_NOT_FOUND).
 */
function requireGame(user: User, rawTitle: string, owner?: string): Game {
  const game = findGameOrNull(user, rawTitle, owner);
  if (!game) throw new TRPCError({ code: 'NOT_FOUND', message: 'Game not found', cause: gameNotFound() });
  return game;
}

/** Like requireGame, but an unknown title (in the target namespace) is null. */
function findGameOrNull(user: User, rawTitle: string, owner?: string): Game | null {
  const title = requireGameTitle(rawTitle);
  let ownerId = user.id;
  if (owner && owner !== user.id) {
    if (user.role !== 'admin') throw new TRPCError({ code: 'FORBIDDEN', message: 'Only admins may target another owner' });
    if (!database.getUserById(owner)) throw new TRPCError({ code: 'NOT_FOUND', message: 'User not found' });
    ownerId = owner;
  }
  return database.findGame(ownerId, title) ?? null;
}

const gameRef = z.object({ game: z.string(), owner: z.string().optional() });

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
        // DUN-086/093: shared title rules; stored name is the trimmed title.
        const name = requireGameTitle(input.name);
        const game = database.upsertGame({
          name,
          ownerId: ctx.user.id,
          status: input.status || 'Pending Upload',
          lastSync: input.lastSync || 'Never',
          // undefined preserves an existing game's cover art on re-add.
          thumbnail: input.thumbnail,
        });
        // `games` (the row) kept for the existing client contract.
        return { success: true, games: game };
      }),

    rename: authedProcedure
      .input(z.object({ id: z.number().int().positive(), name: z.string() }))
      .mutation(async ({ ctx, input }) => {
        // Files stay in saves/<owner>/<gameId>; only the row changes.
        const r = database.renameGame(input.id, ctx.user.id, requireGameTitle(input.name));
        if (r === 'not_found') throw new TRPCError({ code: 'NOT_FOUND', message: 'Game not found', cause: gameNotFound() });
        if (r === 'conflict') throw new TRPCError({ code: 'CONFLICT', message: 'A game with this name already exists' });
        return { success: true };
      }),

    remove: authedProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ ctx, input }) => {
        // DUN-087: callers delete only their own games.
        const deleted = database.deleteGame(input.id, ctx.user.id);
        if (!deleted) throw new TRPCError({ code: 'NOT_FOUND', message: 'Game not found', cause: gameNotFound() });
        fs.rmSync(getGameRoot(input.id, ctx.user.id), { recursive: true, force: true });
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
      .input(gameRef)
      .query(async ({ ctx, input }) => {
        const g = findGameOrNull(ctx.user, input.game, input.owner);
        return { success: true, files: g ? manifestForGame(g.id, g.ownerId) : [] };
      }),
  },

  files: {
    list: authedProcedure
      .input(gameRef)
      .query(async ({ ctx, input }) => {
        const g = findGameOrNull(ctx.user, input.game, input.owner);
        if (!g) return { success: true, files: [] };
        const gameDir = getGameRoot(g.id, g.ownerId);
        if (!fs.existsSync(gameDir)) return { success: true, files: [] };
        const files = listFilesInDir(gameDir);
        return { success: true, files };
      }),

    remove: authedProcedure
      .input(gameRef.extend({ path: z.string() }))
      .mutation(async ({ ctx, input }) => {
        // DUN-086/087: own game only; removeGameFile validates the path
        // (shared rules, no symlinks, strictly inside saves/<owner>/<gameId>).
        // Rejects -> BAD_REQUEST with data.code (e.g. DOT_SEGMENT, OUTSIDE_ROOT).
        const rel = validateRelativeSavePath(input.path);
        if (!rel.ok) throw new PathRuleError(rel.code, rel.message);
        const g = requireGame(ctx.user, input.game, input.owner);
        if (!removeGameFile(g.id, input.path, g.ownerId)) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'File not found' });
        }
        return { success: true };
      }),

    versions: {
      list: authedProcedure
        .input(gameRef)
        .query(async ({ ctx, input }) => {
          const g = findGameOrNull(ctx.user, input.game, input.owner);
          if (!g) return { success: true, versions: [] };
          const versionsRoot = path.join(getGameRoot(g.id, g.ownerId), '.versions');
          if (!fs.existsSync(versionsRoot)) return { success: true, versions: [] };
          const folders = fs.readdirSync(versionsRoot).filter(f => UPLOAD_VERSION_ID.test(f));
          const versions = folders.map(f => ({
            id: f,
            timestamp: new Date(parseInt(f)).toISOString()
          })).sort((a, b) => parseInt(b.id) - parseInt(a.id));
          return { success: true, versions };
        }),

      files: authedProcedure
        .input(gameRef.extend({ versionId: z.string() }))
        .query(async ({ ctx, input }) => {
          // DUN-125: stored snapshot ids only (digits from uploads, UUIDs
          // from directory snapshots); anything else is BAD_REQUEST INVALID_VERSION_ID, then the same
          // containment rules as file paths.
          if (!VERSION_DIR_ID.test(input.versionId)) {
            throw new PathRuleError('INVALID_VERSION_ID', 'Invalid version id');
          }
          const g = findGameOrNull(ctx.user, input.game, input.owner);
          if (!g) return { success: true, files: [] };
          const versionDir = resolveGameSubdir(g.id, `.versions/${input.versionId}`, g.ownerId);
          if (!fs.existsSync(versionDir)) return { success: true, files: [] };
          return { success: true, files: listFilesInDir(versionDir) };
        }),
    },
  },

  art: {
    search: authedProcedure
      .input(z.object({ query: z.string().min(1) }))
      .query(async ({ input }) => {
        return withSteamGridKey((apiKey) => searchArt(apiKey, input.query));
      }),

    autoMatch: authedProcedure.mutation(async ({ ctx }) => {
      const games = database.getGamesForUser(ctx.user);
      const matched = await withSteamGridKey((apiKey) => autoMatchAll(apiKey, games));
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
        const game = requireGame(ctx.user, input.gameName);
        database.upsertGame({ ...game, thumbnail: input.url });
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
          const game = database.findGame(ctx.user.id, requireGameTitle(input.gameName));
          if (game) database.upsertGame({ ...game, analysis: result.analysis });
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
    get: authedProcedure.query(async () => {
      const settings = database.getSettings();
      // DUN-092: the SteamGridDB key is write-only; expose only whether it is set.
      return {
        success: true,
        settings: {
          ...settings,
          apiKeys: settings.apiKeys.map(() => '****'),
          steamGridApiKeySet: steamGridKeyStatus().set,
        },
      };
    }),

    update: adminProcedure
      .input(z.object({
        maxVersions: z.number().int().positive().max(100).optional(),
        ollamaEndpoint: z.string().url().optional(),
        ollamaModel: z.string().optional(),
        autoSyncEnabled: z.boolean().optional(),
        autoSyncFreq: z.enum(['never', '1h', '6h', '24h']).optional(),
      }).strict())
      .mutation(async ({ input }) => {
        const current = database.getSettings();
        const merged = { ...current, ...input };
        database.saveSettings(merged);
        return { success: true };
      }),
  },

  // DUN-092: write-only provider key. Only `{ set }` ever leaves the server.
  providerKeys: {
    steamGridDb: {
      status: authedProcedure.query(() => steamGridKeyStatus()),
      set: adminProcedure
        .input(z.object({ key: z.string() }).strict())
        .mutation(({ input }) => setSteamGridKey(input.key)),
      clear: adminProcedure.mutation(() => clearSteamGridKey()),
    },
  },

  health: publicProcedure.query(async () => {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }),
});

export type AppRouter = typeof appRouter;
