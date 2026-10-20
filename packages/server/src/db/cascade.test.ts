import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import request from 'supertest';

// DUN-085 regression: a successful upload must never cascade-delete child
// rows (save_versions, save_file_snapshots, conflict_records, backup_profiles)
// for any user. Full stack: Express route -> handleUploadFile -> SQLite.
const SETUP_DATA_DIR = process.env.DATA_DIR as string; // temp dir from src/test/setup.ts (DUN-005)
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dune-cascade-test-'));
process.env.DATA_DIR = TMP;
process.env.API_KEY_SECRET = 'cascade-test-secret-0123456789abcdef';

const { app } = await import('../server.js');
const { database, closeDbForTests } = await import('./index.js');
const { getDb } = await import('./sqlite.js');
const { createSaveVersion } = await import('../services/saveVersions.js');
const { recordConflict } = await import('../services/conflicts.js');
const { upsertBackupProfile } = await import('../services/backupProfiles.js');

interface Seeded {
  userId: string;
  key: string;
  games: Record<string, number>;
}

let alice: Seeded;
let bob: Seeded;
let syncCounter = 1_000_000;

function upload(key: string, game: string, file: string, body: string) {
  return request(app)
    .post('/api/upload-file')
    .set('x-api-key', key)
    .set('x-game', game)
    .set('x-path', file)
    .set('x-sync-id', String(syncCounter++))
    .set('Content-Type', 'application/octet-stream')
    .send(Buffer.from(body));
}

type Snapshot = Record<'games' | 'save_versions' | 'save_file_snapshots' | 'conflict_records' | 'backup_profiles', string[]>;

/** Sorted primary keys of every relevant table: same ids => same rows survived. */
function snapshot(): Snapshot {
  const ids = (sql: string) =>
    (getDb().prepare(sql).all() as Array<{ k: unknown }>).map((r) => String(r.k)).sort();
  return {
    games: ids('SELECT id AS k FROM games'),
    save_versions: ids('SELECT id AS k FROM save_versions'),
    save_file_snapshots: ids('SELECT id AS k FROM save_file_snapshots'),
    conflict_records: ids('SELECT id AS k FROM conflict_records'),
    backup_profiles: ids('SELECT gameId AS k FROM backup_profiles'),
  };
}

function countFor(table: string, gameId: number): number {
  const row = getDb().prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE gameId = ?`).get(gameId) as { n: number };
  return Number(row.n);
}

function snapshotCountFor(gameId: number): number {
  const row = getDb()
    .prepare('SELECT COUNT(*) AS n FROM save_file_snapshots s JOIN save_versions v ON v.id = s.versionId WHERE v.gameId = ?')
    .get(gameId) as { n: number };
  return Number(row.n);
}

/** Two versions (2 file snapshots each), one conflict and one backup profile. */
function seedChildren(gameId: number, ownerId: string): void {
  const files = (tag: string) => [
    { path: `${tag}/slot1.sav`, size: 10, hash: `${tag}-h1`, mtime: '2026-01-01T00:00:00.000Z' },
    { path: `${tag}/slot2.sav`, size: 20, hash: `${tag}-h2`, mtime: '2026-01-01T00:00:00.000Z' },
  ];
  const v1 = createSaveVersion({ gameId, ownerId, deviceId: 'dev-1', files: files('v1') });
  const v2 = createSaveVersion({ gameId, ownerId, deviceId: 'dev-2', files: files('v2'), parentVersionId: v1.id });
  recordConflict(gameId, v1.id, v2.id);
  upsertBackupProfile({
    gameId,
    includeGlobs: ['**/*.sav'],
    excludeGlobs: ['cache/**'],
    autoExcludeCache: true,
    maxFileSizeMB: 50,
    updatedAt: new Date().toISOString(),
  });
}

async function seedUser(name: string, gameNames: string[]): Promise<Seeded> {
  const user = database.createUser(name, 'member');
  const key = database.issueUserKey(user.id, 'cascade test');
  const games: Record<string, number> = {};
  for (const g of gameNames) {
    const res = await upload(key, g, 'save.sav', `${name}-${g}-initial`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const row = database.getGames(user.id).find((r) => r.name === g);
    expect(row).toBeDefined();
    games[g] = row!.id;
    seedChildren(row!.id, user.id);
  }
  return { userId: user.id, key, games };
}

beforeAll(async () => {
  alice = await seedUser('cascade-alice', ['Alice One', 'Alice Two']);
  bob = await seedUser('cascade-bob', ['Bob One', 'Bob Two']);
});

afterAll(() => {
  closeDbForTests();
  process.env.DATA_DIR = SETUP_DATA_DIR; // restore the temp dir, never unset (DUN-005)
  delete process.env.API_KEY_SECRET;
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('DUN-085: uploads never cascade-delete child rows', () => {
  it('runs with foreign keys enforced (so a bulk games delete WOULD cascade)', () => {
    const row = getDb().prepare('PRAGMA foreign_keys').get() as { foreign_keys: number };
    expect(Number(row.foreign_keys)).toBe(1);
  });

  it('seeded 2 users x 2 games, each with versions, snapshots, a conflict and a backup profile', () => {
    for (const u of [alice, bob]) {
      for (const id of Object.values(u.games)) {
        expect(countFor('save_versions', id)).toBe(2);
        expect(snapshotCountFor(id)).toBe(4);
        expect(countFor('conflict_records', id)).toBe(1);
        expect(countFor('backup_profiles', id)).toBe(1);
      }
    }
    const s = snapshot();
    expect(s.save_versions).toHaveLength(8);
    expect(s.save_file_snapshots).toHaveLength(16);
    expect(s.conflict_records).toHaveLength(4);
    expect(s.backup_profiles).toHaveLength(4);
  });

  it('one upload keeps versions and profiles (original repro: must not drop to 0)', async () => {
    const aliceOne = alice.games['Alice One'];
    const bobOne = bob.games['Bob One'];
    const before = snapshot();

    const res = await upload(alice.key, 'Alice One', 'save.sav', 'alice-one-v2');
    expect(res.body.success).toBe(true);

    expect(snapshot()).toEqual(before);
    expect(countFor('save_versions', aliceOne)).toBe(2);
    expect(countFor('backup_profiles', aliceOne)).toBe(1);
    expect(countFor('save_versions', bobOne)).toBe(2);
    expect(countFor('backup_profiles', bobOne)).toBe(1);
  });

  it('repeated uploads to same/different/new games by both users preserve every child row id', async () => {
    const before = snapshot();
    const plan: Array<[Seeded, string]> = [
      [alice, 'Alice One'],
      [alice, 'Alice One'],
      [bob, 'Bob One'],
      [alice, 'Alice Two'],
      [bob, 'Bob Two'],
      [bob, 'Bob Two'],
      [alice, 'Alice Three'], // brand-new game -> new games row only
      [bob, 'Bob Three'],
      [alice, 'Alice One'],
    ];
    let i = 0;
    for (const [u, game] of plan) {
      const res = await upload(u.key, game, `slot-${i}.sav`, `payload-${i}`);
      i++;
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    }

    const after = snapshot();
    expect(after.save_versions).toEqual(before.save_versions);
    expect(after.save_file_snapshots).toEqual(before.save_file_snapshots);
    expect(after.conflict_records).toEqual(before.conflict_records);
    expect(after.backup_profiles).toEqual(before.backup_profiles);
    // Existing game rows keep their ids (updated in place, not re-inserted);
    // only the two new games were added.
    for (const id of before.games) expect(after.games).toContain(id);
    expect(after.games).toHaveLength(before.games.length + 2);

    for (const u of [alice, bob]) {
      for (const [name, id] of Object.entries(u.games)) {
        const g = database.getGames(u.userId).find((r) => r.id === id);
        expect(g?.name).toBe(name);
        expect(g?.status).toBe('In Sync');
        expect(countFor('save_versions', id)).toBe(2);
        expect(snapshotCountFor(id)).toBe(4);
        expect(countFor('conflict_records', id)).toBe(1);
        expect(countFor('backup_profiles', id)).toBe(1);
      }
    }
  });

  it('deleting a user removes only that user\'s games and their child rows', async () => {
    const carol = await seedUser('cascade-carol', ['Carol One']);
    const carolGame = carol.games['Carol One'];
    const before = snapshot();
    expect(countFor('save_versions', carolGame)).toBe(2);

    expect(database.deleteUser(carol.userId)).toBe(true);

    // Not orphaned (ownerId SET NULL) but actually gone, with children.
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM games WHERE id = ?').get(carolGame)).toEqual({ n: 0 });
    expect(countFor('save_versions', carolGame)).toBe(0);
    expect(snapshotCountFor(carolGame)).toBe(0);
    expect(countFor('conflict_records', carolGame)).toBe(0);
    expect(countFor('backup_profiles', carolGame)).toBe(0);

    const after = snapshot();
    expect(after.games).toEqual(before.games.filter((id) => id !== String(carolGame)));
    expect(after.save_versions).toHaveLength(before.save_versions.length - 2);
    expect(after.conflict_records).toHaveLength(before.conflict_records.length - 1);
    for (const u of [alice, bob]) {
      for (const id of Object.values(u.games)) {
        expect(countFor('save_versions', id)).toBe(2);
        expect(countFor('backup_profiles', id)).toBe(1);
      }
    }
  });

  it('a genuine single-game delete still cascades for that game only', () => {
    const target = bob.games['Bob Two'];
    const before = snapshot();
    const targetVersions = (getDb().prepare('SELECT id FROM save_versions WHERE gameId = ?').all(target) as Array<{ id: string }>).map((r) => r.id);
    expect(targetVersions).toHaveLength(2);

    // Another user's id-scoped delete must not touch Bob's game.
    expect(database.deleteGame(target, alice.userId)).toBe(false);
    expect(snapshot()).toEqual(before);

    expect(database.deleteGame(target, bob.userId)).toBe(true);

    expect(countFor('save_versions', target)).toBe(0);
    expect(snapshotCountFor(target)).toBe(0);
    expect(countFor('conflict_records', target)).toBe(0);
    expect(countFor('backup_profiles', target)).toBe(0);
    const orphanSnaps = getDb()
      .prepare(`SELECT COUNT(*) AS n FROM save_file_snapshots WHERE versionId IN (${targetVersions.map(() => '?').join(',')})`)
      .get(...targetVersions) as { n: number };
    expect(Number(orphanSnaps.n)).toBe(0);

    const after = snapshot();
    expect(after.games).toEqual(before.games.filter((id) => id !== String(target)));
    expect(after.save_versions).toHaveLength(before.save_versions.length - 2);
    expect(after.save_file_snapshots).toHaveLength(before.save_file_snapshots.length - 4);
    expect(after.conflict_records).toHaveLength(before.conflict_records.length - 1);
    expect(after.backup_profiles).toEqual(before.backup_profiles.filter((id) => id !== String(target)));

    // Every other game (both users) is untouched.
    for (const u of [alice, bob]) {
      for (const id of Object.values(u.games)) {
        if (id === target) continue;
        expect(countFor('save_versions', id)).toBe(2);
        expect(snapshotCountFor(id)).toBe(4);
        expect(countFor('conflict_records', id)).toBe(1);
        expect(countFor('backup_profiles', id)).toBe(1);
      }
    }
  });
});
