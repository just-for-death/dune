import { describe, expect, it } from 'vitest';
import { expandPath } from './utils';

describe('expandPath (DUN-078)', () => {
  const winEnv = { USERPROFILE: 'C:\\Users\\a', APPDATA: 'C:\\Users\\a\\AppData\\Roaming', LocalAppData: 'C:\\Users\\a\\AppData\\Local' };
  it('expands every %VAR% on Windows, case-insensitively', () => {
    expect(expandPath('%APPDATA%\\Game\\saves', winEnv, 'win32')).toBe('C:\\Users\\a\\AppData\\Roaming\\Game\\saves');
    expect(expandPath('%LOCALAPPDATA%\\G', winEnv, 'win32')).toBe('C:\\Users\\a\\AppData\\Local\\G');
    expect(expandPath('%userprofile%\\Documents', winEnv, 'win32')).toBe('C:\\Users\\a\\Documents');
    expect(expandPath('~\\Saved Games', winEnv, 'win32')).toBe('C:\\Users\\a\\Saved Games');
  });
  it('returns empty for an unset variable instead of a literal %VAR% folder', () => {
    expect(expandPath('%PROGRAMDATA%\\G', winEnv, 'win32')).toBe('');
  });
  it('expands only a leading ~ on POSIX and leaves %VAR% alone', () => {
    expect(expandPath('~/.local/share/G', { HOME: '/home/u' }, 'linux')).toBe('/home/u/.local/share/G');
    expect(expandPath('~', { HOME: '/home/u' }, 'linux')).toBe('/home/u');
    expect(expandPath('/opt/~x/%APPDATA%', { HOME: '/home/u' }, 'linux')).toBe('/opt/~x/%APPDATA%');
    expect(expandPath('', {}, 'linux')).toBe('');
  });
});
