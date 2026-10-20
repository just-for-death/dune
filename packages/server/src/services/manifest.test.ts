import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Isolate the data dir before importing the service (static imports hoist).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dune-manifest-test-'));
const SETUP_DATA_DIR = process.env.DATA_DIR as string; // temp dir from src/test/setup.ts (DUN-005)
process.env.DATA_DIR = TMP;

const { manifestForGame, removeGameFile, clearManifestCache } = await import('./manifest.js');

const savesDir = path.join(TMP, 'saves');

afterAll(() => {
  process.env.DATA_DIR = SETUP_DATA_DIR; // restore the temp dir, never unset (DUN-005)
  fs.rmSync(TMP, { recursive: true, force: true });
});

beforeEach(() => {
  clearManifestCache();
  fs.rmSync(savesDir, { recursive: true, force: true });
  fs.mkdirSync(savesDir, { recursive: true });
});

// Saves live at saves/<ownerId>/<gameId> (DUN-086).
const OWNER = 'usr_manifest';
const HADES = 1;

function writeGameFile(gameId: number, rel: string, contents: string): string {
  const abs = path.join(savesDir, OWNER, String(gameId), rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, contents);
  return abs;
}

describe('manifestForGame', () => {
  it('returns an empty list for an unknown game', () => {
    expect(manifestForGame(99, OWNER)).toEqual([]);
  });

  it('fingerprints every file with size, mtime and a content hash', () => {
    writeGameFile(HADES, 'slot1.sav', 'hello');
    writeGameFile(HADES, 'config/options.ini', 'vsync=1');

    const manifest = manifestForGame(HADES, OWNER);
    expect(manifest.map(e => e.path).sort()).toEqual(['config/options.ini', 'slot1.sav']);

    const slot = manifest.find(e => e.path === 'slot1.sav');
    expect(slot?.size).toBe(5);
    expect(slot?.hash).toMatch(/^[0-9a-f]{64}$/);

    // Same content -> same hash regardless of which file it lives in.
    writeGameFile(HADES, 'copy.sav', 'hello');
    const copy = manifestForGame(HADES, OWNER).find(e => e.path === 'copy.sav');
    expect(copy?.hash).toBe(slot?.hash);
  });

  it('skips the .versions history and symlinks', () => {
    writeGameFile(HADES, 'slot1.sav', 'x');
    writeGameFile(HADES, '.versions/1234/slot1.sav', 'old');

    // Symlink (best-effort: some CI filesystems disallow it).
    try {
      fs.symlinkSync(path.join(savesDir, OWNER, String(HADES), 'slot1.sav'), path.join(savesDir, OWNER, String(HADES), 'link.sav'));
    } catch {
      /* ignore */
    }

    const paths = manifestForGame(HADES, OWNER).map(e => e.path);
    expect(paths).toContain('slot1.sav');
    expect(paths.some(p => p.includes('.versions'))).toBe(false);
    expect(paths).not.toContain('link.sav');
  });

  it('re-hashes after a write (cache invalidated by size/mtime)', () => {
    const abs = writeGameFile(HADES, 'slot1.sav', 'version-one');
    const first = manifestForGame(HADES, OWNER).find(e => e.path === 'slot1.sav')!.hash;

    fs.writeFileSync(abs, 'version-two-longer');
    clearManifestCache();
    const second = manifestForGame(HADES, OWNER).find(e => e.path === 'slot1.sav')!.hash;

    expect(second).not.toBe(first);
  });
});

describe('removeGameFile', () => {
  it('removes an existing file and reports a miss otherwise', () => {
    writeGameFile(HADES, 'slot1.sav', 'x');
    expect(removeGameFile(HADES, 'slot1.sav', OWNER)).toBe(true);
    expect(fs.existsSync(path.join(savesDir, OWNER, String(HADES), 'slot1.sav'))).toBe(false);
    expect(removeGameFile(HADES, 'slot1.sav', OWNER)).toBe(false);
  });
});
