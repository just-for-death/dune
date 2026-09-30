import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { getFileCategory, validateGamePath, getGameRoot, listFilesInDir } from './path.js';

const TEST_DIR = path.join(process.cwd(), 'test-data');

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

describe('validateGamePath', () => {
  it('should sanitize path traversal attempts', () => {
    const result1 = validateGamePath('test', '../etc/passwd');
    expect(result1).not.toContain('..');
    
    const result2 = validateGamePath('test', '..\\windows\\system32');
    expect(result2).not.toContain('..');
    
    const result3 = validateGamePath('test', '../../etc/passwd');
    expect(result3).not.toContain('..');
  });

  it('should sanitize dangerous characters', () => {
    const result = validateGamePath('test', 'file<>:|?*.txt');
    expect(result).not.toContain('<');
    expect(result).not.toContain('>');
    expect(result).not.toContain(':');
    expect(result).not.toContain('|');
    expect(result).not.toContain('?');
    expect(result).not.toContain('*');
  });

  it('should return valid path for normal files', () => {
    const result = validateGamePath('My Game', 'saves/slot1.sav');
    expect(result).toContain('My Game');
    expect(result).toContain('saves/slot1.sav');
  });
});

describe('getGameRoot', () => {
  it('should sanitize game name', () => {
    const root = getGameRoot('My<Game>:Test');
    expect(root).not.toContain('<');
    expect(root).not.toContain('>');
    expect(root).not.toContain(':');
  });

  it('should prevent directory traversal in game name', () => {
    const root = getGameRoot('../../../etc');
    expect(root).toContain('etc');
    expect(root).not.toContain('..');
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
