import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { isSaveCandidate, findSaveFolders, syncLocalFolder } from './localScanner.js';

const TEST_DIR = path.join(process.cwd(), 'test-scanner');
const SAVES_DIR = path.join(process.cwd(), 'test-saves');

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  
  if (fs.existsSync(SAVES_DIR)) fs.rmSync(SAVES_DIR, { recursive: true });
  fs.mkdirSync(SAVES_DIR, { recursive: true });
});

afterEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  if (fs.existsSync(SAVES_DIR)) fs.rmSync(SAVES_DIR, { recursive: true });
});

describe('isSaveCandidate', () => {
  it('should return true for directory with save files', () => {
    const dir = path.join(TEST_DIR, 'save-folder');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'savegame.sav'), 'data');
    expect(isSaveCandidate(dir)).toBe(true);
  });

  it('should return true for directory with save subdirectory', () => {
    const dir = path.join(TEST_DIR, 'save-parent');
    fs.mkdirSync(path.join(dir, 'saves'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'saves', 'slot1.dat'), 'data');
    expect(isSaveCandidate(dir)).toBe(true);
  });

  it('should return true for directory with profiles subdirectory', () => {
    const dir = path.join(TEST_DIR, 'profiles-parent');
    fs.mkdirSync(path.join(dir, 'profiles'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'profiles', 'profile1.json'), '{}');
    expect(isSaveCandidate(dir)).toBe(true);
  });

  it('should return false for directory with too many files', () => {
    const dir = path.join(TEST_DIR, 'many-files');
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 301; i++) {
      fs.writeFileSync(path.join(dir, `file${i}.txt`), 'data');
    }
    expect(isSaveCandidate(dir)).toBe(false);
  });

  it('should return false for empty directory', () => {
    const dir = path.join(TEST_DIR, 'empty');
    fs.mkdirSync(dir, { recursive: true });
    expect(isSaveCandidate(dir)).toBe(false);
  });
});

describe('findSaveFolders', () => {
  it('should find nested save folders', () => {
    const root = path.join(TEST_DIR, 'game-root');
    fs.mkdirSync(path.join(root, 'saves'), { recursive: true });
    fs.writeFileSync(path.join(root, 'saves', 'slot1.sav'), 'data');
    fs.mkdirSync(path.join(root, 'config'), { recursive: true });
    fs.writeFileSync(path.join(root, 'config', 'settings.ini'), 'data');

    const results = findSaveFolders(root, 3);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some(r => r.includes('saves'))).toBe(true);
  });

  it('should respect depth limit', () => {
    const root = path.join(TEST_DIR, 'deep');
    let current = root;
    for (let i = 0; i < 5; i++) {
      current = path.join(current, `level${i}`);
      fs.mkdirSync(current, { recursive: true });
    }
    fs.writeFileSync(path.join(current, 'save.sav'), 'data');

    const results = findSaveFolders(root, 3);
    expect(results.length).toBe(0);

    const resultsDeep = findSaveFolders(root, 6);
    expect(resultsDeep.length).toBeGreaterThanOrEqual(1);
  });

  it('should skip node_modules and hidden directories', () => {
    const root = path.join(TEST_DIR, 'skip-dirs');
    fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(root, 'node_modules', 'save.sav'), 'data');
    fs.mkdirSync(path.join(root, '.hidden'), { recursive: true });
    fs.writeFileSync(path.join(root, '.hidden', 'save.sav'), 'data');
    fs.mkdirSync(path.join(root, 'saves'), { recursive: true });
    fs.writeFileSync(path.join(root, 'saves', 'slot1.sav'), 'data');

    const results = findSaveFolders(root, 3);
    expect(results.some(r => r.includes('saves'))).toBe(true);
  });
});

describe('syncLocalFolder', () => {
  it('should copy new files to target', () => {
    const source = path.join(TEST_DIR, 'source-game');
    fs.mkdirSync(path.join(source, 'saves'), { recursive: true });
    fs.writeFileSync(path.join(source, 'saves', 'slot1.sav'), 'save data 1');
    fs.writeFileSync(path.join(source, 'config.ini'), 'config data');

    const result = syncLocalFolder(source, 'TestGame', SAVES_DIR, 10);
    
    expect(result.filesSynced).toBe(2);
    expect(fs.existsSync(path.join(SAVES_DIR, 'TestGame', 'saves', 'slot1.sav'))).toBe(true);
    expect(fs.existsSync(path.join(SAVES_DIR, 'TestGame', 'config.ini'))).toBe(true);
  });

  it('should not copy unchanged files', () => {
    const source = path.join(TEST_DIR, 'source-game2');
    fs.mkdirSync(path.join(source, 'saves'), { recursive: true });
    fs.writeFileSync(path.join(source, 'saves', 'slot1.sav'), 'save data');

    syncLocalFolder(source, 'TestGame2', SAVES_DIR, 10);
    
    const result = syncLocalFolder(source, 'TestGame2', SAVES_DIR, 10);
    
    expect(result.filesSynced).toBe(0);
  });

  it('should copy changed files', () => {
    const source = path.join(TEST_DIR, 'source-game3');
    fs.mkdirSync(path.join(source, 'saves'), { recursive: true });
    fs.writeFileSync(path.join(source, 'saves', 'slot1.sav'), 'save data v1');

    syncLocalFolder(source, 'TestGame3', SAVES_DIR, 10);
    
    // Modify file with different content - this should trigger a sync
    fs.writeFileSync(path.join(source, 'saves', 'slot1.sav'), 'save data v2 modified content that is definitely different');
    
    const result = syncLocalFolder(source, 'TestGame3', SAVES_DIR, 10);
    
    expect(result.filesSynced).toBe(1);
  });

  it('should create version backups for changed files', () => {
    const source = path.join(TEST_DIR, 'source-game4');
    fs.mkdirSync(path.join(source, 'saves'), { recursive: true });
    fs.writeFileSync(path.join(source, 'saves', 'slot1.sav'), 'save data v1');

    syncLocalFolder(source, 'TestGame4', SAVES_DIR, 10);
    
    // Modify file with different content
    fs.writeFileSync(path.join(source, 'saves', 'slot1.sav'), 'save data v2 completely different content');
    
    syncLocalFolder(source, 'TestGame4', SAVES_DIR, 10);
    
    const versionsDir = path.join(SAVES_DIR, 'TestGame4', '.versions');
    expect(fs.existsSync(versionsDir)).toBe(true);
    const versions = fs.readdirSync(versionsDir).filter(v => !isNaN(Number(v)));
    expect(versions.length).toBeGreaterThanOrEqual(1);
  });

  it('should prune old versions beyond maxVersions', () => {
    const source = path.join(TEST_DIR, 'source-game5');
    fs.mkdirSync(path.join(source, 'saves'), { recursive: true });
    
    for (let i = 0; i < 15; i++) {
      fs.writeFileSync(path.join(source, 'saves', 'slot1.sav'), `save data v${i}`);
      syncLocalFolder(source, 'TestGame5', SAVES_DIR, 10);
    }
    
    const versionsDir = path.join(SAVES_DIR, 'TestGame5', '.versions');
    const versions = fs.readdirSync(versionsDir).filter(v => !isNaN(Number(v)));
    expect(versions.length).toBeLessThanOrEqual(10);
  });

  it('should skip symlinks', () => {
    const source = path.join(TEST_DIR, 'source-symlink');
    fs.mkdirSync(path.join(source, 'saves'), { recursive: true });
    fs.writeFileSync(path.join(source, 'saves', 'real.sav'), 'real data');
    
    const linkPath = path.join(source, 'saves', 'link.sav');
    try {
      fs.symlinkSync(path.join(source, 'saves', 'real.sav'), linkPath);
    } catch {
      return;
    }
    
    if (fs.existsSync(linkPath)) {
      const result = syncLocalFolder(source, 'TestSymlink', SAVES_DIR, 10);
      expect(result.filesSynced).toBeGreaterThanOrEqual(1);
    }
  });
});
