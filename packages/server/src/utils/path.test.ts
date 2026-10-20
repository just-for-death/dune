import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
  getFileCategory,
  getGameRoot,
  listFilesInDir,
  dataDir,
  packageDataDir,
  assertTestDataDirIsolated,
  canonicalPath,
  pathRelation,
  savesDir,
  resolveGameFile,
  gameFolderName,
  ownerSavesRoot,
  assertStrictlyInside,
  PathRuleError,
  requireGameTitle,
} from './path.js';
import { apiErrorBody } from './apiError.js';

// DUN-022: scratch space lives under the OS temp dir, never the package root.
const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dune-path-test-'));
const TEST_DIR = path.join(TEST_ROOT, 'test-data');

afterAll(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('getFileCategory', () => {
  it('should categorize save files correctly', () => {
    expect(getFileCategory('saves/game.sav')).toBe('Save');
    expect(getFileCategory('profile.bin')).toBe('Save');
    expect(getFileCategory('savegame.dat')).toBe('Save');
    expect(getFileCategory('slot1.prof')).toBe('Save');
  });

  it('should categorize config files correctly', () => {
    expect(getFileCategory('config.ini')).toBe('Config');
    expect(getFileCategory('settings.cfg')).toBe('Config');
    expect(getFileCategory('options.xml')).toBe('Config');
    expect(getFileCategory('preferences.json')).toBe('Config');
    expect(getFileCategory('config.yaml')).toBe('Config');
    expect(getFileCategory('config.yml')).toBe('Config');
  });

  it('should categorize cache files correctly', () => {
    expect(getFileCategory('cache/data.tmp')).toBe('Cache');
    expect(getFileCategory('cache/log.txt')).toBe('Cache');
    expect(getFileCategory('some/cache/file')).toBe('Cache');
    expect(getFileCategory('file.cache')).toBe('Cache');
  });

  it('should categorize other files as Other', () => {
    expect(getFileCategory('readme.txt')).toBe('Other');
    expect(getFileCategory('image.png')).toBe('Other');
    expect(getFileCategory('document.pdf')).toBe('Other');
  });
});

function codeOf(fn: () => unknown): string {
  try {
    fn();
    return 'OK';
  } catch (err) {
    return err instanceof PathRuleError ? err.code : `THREW:${(err as Error).message}`;
  }
}

describe('resolveGameFile (DUN-086: reject, never strip)', () => {
  it.each([
    ['../etc/passwd', 'DOT_SEGMENT'],
    ['..\\windows\\system32', 'DOT_SEGMENT'],
    ['../../../sentinel.txt', 'DOT_SEGMENT'],
    ['subdir/../../x', 'DOT_SEGMENT'],
    ['/etc/x', 'ABSOLUTE'],
    ['C:\\x', 'ABSOLUTE'],
    ['\\\\server\\x', 'ABSOLUTE'],
    ['', 'EMPTY'],
    ['a\0b', 'NUL'],
    ['file<>|?*.txt', 'CHANGED_BY_SANITIZE'],
    ['slot.sav:ads', 'RESERVED'],
  ])('rejects %j with %s', (p, code) => {
    expect(codeOf(() => resolveGameFile(1, p, 'usr_unit'))).toBe(code);
  });

  it('returns validated pieces under saves/<owner>/<gameId>, separators normalized', () => {
    const r = resolveGameFile(7, 'saves\\slot1.sav', 'usr_unit');
    expect(r.rel).toBe('saves/slot1.sav');
    expect(r.root).toBe(path.join(savesDir(), 'usr_unit', '7'));
    expect(r.abs).toBe(path.join(savesDir(), 'usr_unit', '7', 'saves', 'slot1.sav'));
  });

  it('rejects a symlink anywhere below the game root (dir or file), even if it points inside', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'dune-path-outside-'));
    try {
      fs.writeFileSync(path.join(outside, 'sentinel.txt'), 'keep');
      const root = getGameRoot(3, 'usr_unit');
      fs.mkdirSync(root, { recursive: true });
      fs.symlinkSync(outside, path.join(root, 'linkdir'));
      fs.symlinkSync(path.join(outside, 'sentinel.txt'), path.join(root, 'link.sav'));
      fs.writeFileSync(path.join(root, 'real.sav'), 'x');
      fs.symlinkSync(path.join(root, 'real.sav'), path.join(root, 'inner-link.sav'));
      expect(codeOf(() => resolveGameFile(3, 'linkdir/sentinel.txt', 'usr_unit'))).toBe('OUTSIDE_ROOT');
      expect(codeOf(() => resolveGameFile(3, 'link.sav', 'usr_unit'))).toBe('OUTSIDE_ROOT');
      expect(codeOf(() => resolveGameFile(3, 'inner-link.sav', 'usr_unit'))).toBe('OUTSIDE_ROOT');
      expect(codeOf(() => resolveGameFile(3, 'real.sav', 'usr_unit'))).toBe('OK');
      expect(fs.readFileSync(path.join(outside, 'sentinel.txt'), 'utf-8')).toBe('keep');
    } finally {
      fs.rmSync(path.join(savesDir(), 'usr_unit'), { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('rejects a game folder that is itself a symlink to outside saves/<owner>', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'dune-path-outside-'));
    try {
      fs.mkdirSync(ownerSavesRoot('usr_unit'), { recursive: true });
      fs.symlinkSync(outside, path.join(ownerSavesRoot('usr_unit'), '9'));
      expect(codeOf(() => getGameRoot(9, 'usr_unit'))).toBe('OUTSIDE_ROOT');
    } finally {
      fs.rmSync(path.join(savesDir(), 'usr_unit'), { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('error body is exactly { error, code }', () => {
    expect(apiErrorBody(new PathRuleError('DOT_SEGMENT', 'nope'))).toEqual({ error: 'nope', code: 'DOT_SEGMENT' });
  });
});

describe('getGameRoot / gameFolderName (DUN-093: folder = game id, never the title)', () => {
  it('maps a game id to saves/<owner>/<id>', () => {
    expect(gameFolderName(42)).toBe('42');
    expect(getGameRoot(42, 'usr_unit')).toBe(path.join(savesDir(), 'usr_unit', '42'));
  });

  it.each([[0], [-1], [1.5], [Number.NaN], [Number.MAX_SAFE_INTEGER + 1]])('rejects game id %s with INVALID_GAME_ID', (id) => {
    expect(codeOf(() => getGameRoot(id, 'usr_unit'))).toBe('INVALID_GAME_ID');
  });

  it('keeps real titles (colon, quotes, ?, ™) as-is: they never touch the filesystem', () => {
    expect(requireGameTitle('The Witcher 3: Wild Hunt')).toBe('The Witcher 3: Wild Hunt');
    expect(requireGameTitle('  DARK SOULS™ III ')).toBe('DARK SOULS™ III');
    expect(requireGameTitle('"Why?"')).toBe('"Why?"');
  });

  it.each([
    ['', 'EMPTY'],
    ['   ', 'EMPTY'],
    ['a\0b', 'NUL'],
    ['a\u0001b', 'CONTROL'],
    ['a\u007fb', 'CONTROL'],
    ['x'.repeat(201), 'TOO_LONG'],
  ])('rejects game title %j with %s', (name, code) => {
    expect(codeOf(() => requireGameTitle(name))).toBe(code);
  });

  it('never returns saves/<owner> itself or anything outside it', () => {
    const base = ownerSavesRoot('usr_unit');
    const root = getGameRoot(1, 'usr_unit');
    expect(pathRelation(canonicalPath(root), canonicalPath(base))).toBe('inside');
    expect(codeOf(() => assertStrictlyInside(base, base))).toBe('OUTSIDE_ROOT');
    expect(codeOf(() => assertStrictlyInside(path.dirname(base), base))).toBe('OUTSIDE_ROOT');
  });

  it('rejects malformed owner ids', () => {
    expect(codeOf(() => getGameRoot(1, '../x'))).toBe('INVALID_OWNER');
    expect(codeOf(() => getGameRoot(1, ''))).toBe('INVALID_OWNER');
    expect(codeOf(() => getGameRoot(1, 'usr_abc'))).toBe('OK');
  });
});

describe('listFilesInDir', () => {
  it('should list files with metadata', () => {
    const gameDir = path.join(TEST_DIR, 'TestGame');
    fs.mkdirSync(path.join(gameDir, 'saves'), { recursive: true });
    fs.writeFileSync(path.join(gameDir, 'saves', 'slot1.sav'), 'save data');
    fs.writeFileSync(path.join(gameDir, 'config.ini'), 'config data');
    fs.mkdirSync(path.join(gameDir, 'cache'), { recursive: true });
    fs.writeFileSync(path.join(gameDir, 'cache', 'temp.tmp'), 'cache data');

    const files = listFilesInDir(gameDir);
    
    expect(files.length).toBeGreaterThanOrEqual(3);
    const saveFile = files.find(f => f.path === 'saves/slot1.sav');
    expect(saveFile).toBeDefined();
    expect(saveFile?.category).toBe('Save');
    
    const configFile = files.find(f => f.path === 'config.ini');
    expect(configFile).toBeDefined();
    expect(configFile?.category).toBe('Config');
    
    const cacheFile = files.find(f => f.path === 'cache/temp.tmp');
    expect(cacheFile).toBeDefined();
    expect(cacheFile?.category).toBe('Cache');
  });

  it('should ignore .versions directory', () => {
    const gameDir = path.join(TEST_DIR, 'TestGame2');
    fs.mkdirSync(path.join(gameDir, 'saves'), { recursive: true });
    fs.writeFileSync(path.join(gameDir, 'saves', 'slot1.sav'), 'save data');
    fs.mkdirSync(path.join(gameDir, '.versions', '123'), { recursive: true });
    fs.writeFileSync(path.join(gameDir, '.versions', '123', 'old.sav'), 'old data');

    const files = listFilesInDir(gameDir);
    const versionFile = files.find(f => f.path.includes('.versions'));
    expect(versionFile).toBeUndefined();
  });
});

// DUN-005: tests must never resolve to the real <package>/data folder.
// None of these cases create, stat, or read anything inside it: the guard
// throws before dataDir() touches the filesystem.
describe('test data-dir isolation guard (DUN-005)', () => {
  const SETUP_DATA_DIR = process.env.DATA_DIR as string;
  const ORIGINAL_VITEST = process.env.VITEST;
  let scratch: string;

  beforeEach(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dune-guard-test-'));
  });

  afterEach(() => {
    process.env.DATA_DIR = SETUP_DATA_DIR;
    process.env.VITEST = ORIGINAL_VITEST;
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  it('packageDataDir() is <package root>/data', () => {
    expect(packageDataDir()).toBe(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data'));
  });

  it('dataDir() throws under Vitest when DATA_DIR is unset', () => {
    expect(process.env.VITEST).toBeTruthy();
    delete process.env.DATA_DIR;
    expect(() => dataDir()).toThrow(/DUN-005: DATA_DIR is not set under Vitest/);
  });

  it('dataDir() throws under Vitest when DATA_DIR is an empty string', () => {
    process.env.DATA_DIR = '';
    expect(() => dataDir()).toThrow(/DUN-005: DATA_DIR is not set/);
  });

  it.each([
    ['the exact path', () => packageDataDir()],
    ['a trailing separator', () => packageDataDir() + path.sep],
    ['".." segments', () => path.join(packageDataDir(), 'saves', '..')],
    ['a relative path', () => path.relative(process.cwd(), packageDataDir()) || '.'],
  ])('dataDir() throws under Vitest when DATA_DIR points at the real data folder via %s', (_label, make) => {
    process.env.DATA_DIR = make();
    expect(() => dataDir()).toThrow(/DUN-005: DATA_DIR resolves to the real data folder/);
  });

  it('dataDir() throws when DATA_DIR reaches the real data folder through a symlink', () => {
    // Link to the package root (always exists) so the check works even when
    // ./data itself has never been created, e.g. on CI.
    const link = path.join(scratch, 'pkg-link');
    fs.symlinkSync(path.resolve(packageDataDir(), '..'), link, 'dir');
    process.env.DATA_DIR = path.join(link, 'data');
    expect(() => dataDir()).toThrow(/DUN-005/);
  });

  it('dataDir() allows a temp DATA_DIR under Vitest and creates it', () => {
    const dir = path.join(scratch, 'nested', 'data');
    process.env.DATA_DIR = dir;
    expect(dataDir()).toBe(dir);
    expect(fs.statSync(dir).isDirectory()).toBe(true);
  });

  it('assertTestDataDirIsolated throws directly for unset or real-folder inputs under Vitest', () => {
    expect(() => assertTestDataDirIsolated(undefined, packageDataDir())).toThrow(/not set under Vitest/);
    expect(() => assertTestDataDirIsolated(packageDataDir(), packageDataDir())).toThrow(/real data folder/);
    expect(() => assertTestDataDirIsolated(scratch, scratch)).not.toThrow();
  });

  it('is a no-op outside Vitest, so production behaviour is unchanged', () => {
    delete process.env.VITEST;
    expect(() => assertTestDataDirIsolated(undefined, packageDataDir())).not.toThrow();
    expect(() => assertTestDataDirIsolated(packageDataDir(), packageDataDir())).not.toThrow();
    process.env.DATA_DIR = path.join(scratch, 'prod');
    expect(dataDir()).toBe(path.join(scratch, 'prod'));
  });
});

// DUN-022: the guard must also reject DATA_DIRs inside, or containing, the
// real data folder. Containment cases run against a FAKE package built in a
// temp sandbox; the only real-package cases are pure path inputs that throw
// before anything is created. Nothing here creates links or dirs in data/.
describe('test data-dir containment guard (DUN-022)', () => {
  const SETUP_DATA_DIR = process.env.DATA_DIR as string;
  let sandbox: string;
  let pkg: string;
  let fakeData: string;

  /** Recursive listing (incl. symlinks) used to prove the guard never writes. */
  const tree = (root: string): string[] => {
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        out.push(path.relative(root, full) + (e.isSymbolicLink() ? '@' : e.isDirectory() ? '/' : ''));
        if (e.isDirectory() && !e.isSymbolicLink()) walk(full);
      }
    };
    walk(root);
    return out.sort();
  };

  beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'dune-guard-sandbox-'));
    pkg = path.join(sandbox, 'packages', 'server');
    fakeData = path.join(pkg, 'data');
    fs.mkdirSync(path.join(fakeData, 'saves'), { recursive: true });
    fs.mkdirSync(path.join(pkg, 'data2'), { recursive: true });
    fs.mkdirSync(path.join(pkg, 'data-other'), { recursive: true });
  });

  afterEach(() => {
    process.env.DATA_DIR = SETUP_DATA_DIR;
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  const guard = (candidate: string, real = fakeData) => () => assertTestDataDirIsolated(candidate, candidate, real);

  describe('pathRelation (segment-aware)', () => {
    it('classifies equal / inside / contains / unrelated', () => {
      expect(pathRelation('/a/data', '/a/data')).toBe('equal');
      expect(pathRelation('/a/data/saves', '/a/data')).toBe('inside');
      expect(pathRelation('/a/data/x/y', '/a/data')).toBe('inside');
      expect(pathRelation('/a', '/a/data')).toBe('contains');
      expect(pathRelation('/', '/a/data')).toBe('contains');
      expect(pathRelation('/a/data2', '/a/data')).toBe('unrelated');
      expect(pathRelation('/a/data-other', '/a/data')).toBe('unrelated');
      expect(pathRelation('/a/dat', '/a/data')).toBe('unrelated');
      expect(pathRelation('/a/..data', '/a/data')).toBe('unrelated');
      expect(pathRelation('/b/data', '/a/data')).toBe('unrelated');
    });
  });

  describe('fake package in a temp sandbox', () => {
    it('throws when DATA_DIR equals the data folder', () => {
      expect(guard(fakeData)).toThrow(/real data folder/);
      expect(guard(fakeData + path.sep)).toThrow(/real data folder/);
    });

    it('throws when DATA_DIR is inside the data folder (existing and not-yet-existing)', () => {
      expect(guard(path.join(fakeData, 'saves'))).toThrow(/DUN-022: .* is inside the real data folder/);
      expect(guard(path.join(fakeData, 'not', 'yet', 'created'))).toThrow(/is inside/);
      expect(guard(path.join(pkg, 'data2', '..', 'data', 'saves'))).toThrow(/is inside/);
    });

    it('throws when DATA_DIR contains the data folder (package root, packages/, sandbox, /)', () => {
      for (const dir of [pkg, path.dirname(pkg), sandbox, path.parse(sandbox).root]) {
        expect(guard(dir)).toThrow(/DUN-022: .* contains the real data folder/);
      }
    });

    it('throws via symlink: link == data folder', () => {
      const link = path.join(sandbox, 'link-to-data');
      fs.symlinkSync(fakeData, link, 'dir');
      expect(guard(link)).toThrow(/real data folder/);
    });

    it('throws via symlink: link resolves inside the data folder (incl. a not-yet-existing child)', () => {
      const link = path.join(sandbox, 'link-to-data');
      fs.symlinkSync(fakeData, link, 'dir');
      expect(guard(path.join(link, 'saves'))).toThrow(/is inside/);
      expect(guard(path.join(link, 'fresh', 'dir'))).toThrow(/is inside/);
    });

    it('throws via symlink: link resolves to an ancestor of the data folder', () => {
      const link = path.join(sandbox, 'link-to-pkg');
      fs.symlinkSync(pkg, link, 'dir');
      expect(guard(link)).toThrow(/contains/);
    });

    it('resolves symlinks on the protected side too', () => {
      const alias = path.join(sandbox, 'alias-of-data');
      fs.symlinkSync(fakeData, alias, 'dir');
      expect(guard(path.join(fakeData, 'saves'), alias)).toThrow(/is inside/);
      expect(guard(pkg, alias)).toThrow(/contains/);
      expect(guard(path.join(pkg, 'data2'), alias)).not.toThrow();
    });

    it('works when the data folder itself does not exist yet (nearest existing ancestor)', () => {
      const bare = path.join(sandbox, 'bare-pkg');
      fs.mkdirSync(bare);
      const missingData = path.join(bare, 'data');
      expect(guard(bare, missingData)).toThrow(/contains/);
      expect(guard(path.join(missingData, 'saves'), missingData)).toThrow(/is inside/);
      expect(guard(path.join(bare, 'data2'), missingData)).not.toThrow();
    });

    it('allows siblings that only share a name prefix (data2, data-other, data.bak)', () => {
      expect(guard(path.join(pkg, 'data2'))).not.toThrow();
      expect(guard(path.join(pkg, 'data-other'))).not.toThrow();
      expect(guard(path.join(pkg, 'data.bak', 'nested'))).not.toThrow();
      const link = path.join(sandbox, 'link-to-sibling');
      fs.symlinkSync(path.join(pkg, 'data-other'), link, 'dir');
      expect(guard(link)).not.toThrow();
    });

    it('never writes: the sandbox tree is unchanged after throwing and passing checks', () => {
      fs.symlinkSync(fakeData, path.join(sandbox, 'link-to-data'), 'dir');
      const before = tree(sandbox);
      for (const c of [
        path.join(fakeData, 'brand', 'new'),
        path.join(sandbox, 'link-to-data', 'brand', 'new'),
        path.join(pkg, 'data-other', 'brand', 'new'),
        pkg,
      ]) {
        try {
          guard(c)();
        } catch {
          /* expected for some */
        }
      }
      expect(tree(sandbox)).toEqual(before);
    });

    it('canonicalPath resolves the nearest existing ancestor and keeps the missing tail', () => {
      const link = path.join(sandbox, 'link-to-data');
      fs.symlinkSync(fakeData, link, 'dir');
      expect(canonicalPath(path.join(link, 'a', 'b'))).toBe(path.join(fs.realpathSync(fakeData), 'a', 'b'));
    });
  });

  describe('real package (pure path inputs; guard throws before any write)', () => {
    it('dataDir() throws when DATA_DIR is inside the real data folder', () => {
      process.env.DATA_DIR = path.join(packageDataDir(), 'saves');
      expect(() => dataDir()).toThrow(/DUN-022: .* is inside/);
    });

    it('dataDir() throws when DATA_DIR is the package root, packages/, or /', () => {
      const pkgRoot = path.dirname(packageDataDir());
      for (const dir of [pkgRoot, path.dirname(pkgRoot), path.parse(pkgRoot).root]) {
        process.env.DATA_DIR = dir;
        expect(() => dataDir()).toThrow(/DUN-022: .* contains/);
      }
    });

    it('allows a sibling such as <package>/data-other (pure check, nothing created)', () => {
      const sibling = path.join(path.dirname(packageDataDir()), 'data-other');
      expect(() => assertTestDataDirIsolated(sibling, sibling)).not.toThrow();
    });

    it('allows a normal os.tmpdir() DATA_DIR', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dune-guard-ok-'));
      try {
        process.env.DATA_DIR = dir;
        expect(dataDir()).toBe(dir);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
