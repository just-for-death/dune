import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Isolate the data dir before importing the service (static imports hoist).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dune-manifest-test-'));
process.env.DATA_DIR = TMP;

const { manifestForGame, removeGameFile, clearManifestCache } = await import('./manifest.js');

const savesDir = path.join(TMP, 'saves');

afterAll(() => {
  delete process.env.DATA_DIR;
  fs.rmSync(TMP, { recursive: true, force: true });
});

beforeEach(() => {
  clearManifestCache();
  fs.rmSync(savesDir, { recursive: true, force: true });
  fs.mkdirSync(savesDir, { recursive: true });
});

function writeGameFile(game: string, rel: string, contents: string): string {
  const abs = path.join(savesDir, game, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, contents);
  return abs;
}

describe('manifestForGame', () => {
  it('returns an empty list for an unknown game', () => {
    expect(manifestForGame('Nope')).toEqual([]);
  });

  it('fingerprints every file with size, mtime and a content hash', () => {
    writeGameFile('Hades', 'slot1.sav', 'hello');
    writeGameFile('Hades', 'config/options.ini', 'vsync=1');

    const manifest = manifestForGame('Hades');
    expect(manifest.map(e => e.path).sort()).toEqual(['config/options.ini', 'slot1.sav']);

    const slot = manifest.find(e => e.path === 'slot1.sav');
    expect(slot?.size).toBe(5);
    expect(slot?.hash).toMatch(/^[0-9a-f]{64}$/);

    // Same content -> same hash regardless of which file it lives in.
    writeGameFile('Hades', 'copy.sav', 'hello');
    const copy = manifestForGame('Hades').find(e => e.path === 'copy.sav');
    expect(copy?.hash).toBe(slot?.hash);
  });

  it('skips the .versions history and symlinks', () => {
    writeGameFile('Hades', 'slot1.sav', 'x');
    writeGameFile('Hades', '.versions/1234/slot1.sav', 'old');

    // Symlink (best-effort: some CI filesystems disallow it).
    try {
      fs.symlinkSync(path.join(savesDir, 'Hades', 'slot1.sav'), path.join(savesDir, 'Hades', 'link.sav'));
    } catch {
      /* ignore */
    }

    const paths = manifestForGame('Hades').map(e => e.path);
    expect(paths).toContain('slot1.sav');
    expect(paths.some(p => p.includes('.versions'))).toBe(false);
    expect(paths).not.toContain('link.sav');
  });

  it('re-hashes after a write (cache invalidated by size/mtime)', () => {
    const abs = writeGameFile('Hades', 'slot1.sav', 'version-one');
    const first = manifestForGame('Hades').find(e => e.path === 'slot1.sav')!.hash;

    fs.writeFileSync(abs, 'version-two-longer');
    clearManifestCache();
    const second = manifestForGame('Hades').find(e => e.path === 'slot1.sav')!.hash;

    expect(second).not.toBe(first);
  });
});

describe('removeGameFile', () => {
  it('removes an existing file and reports a miss otherwise', () => {
    writeGameFile('Hades', 'slot1.sav', 'x');
    expect(removeGameFile('Hades', 'slot1.sav')).toBe(true);
    expect(fs.existsSync(path.join(savesDir, 'Hades', 'slot1.sav'))).toBe(false);
    expect(removeGameFile('Hades', 'slot1.sav')).toBe(false);
  });
});
