import { describe, it, expect } from 'vitest';
import { isProtectedSaveRoot } from './protectedRoots';

// DUN-065: pure path checks only; no filesystem access.
const linux = { home: '/home/jane', env: {} as NodeJS.ProcessEnv, platform: 'linux' as const };
const win = { home: 'C:\\Users\\Jane', env: { APPDATA: 'C:\\Users\\Jane\\AppData\\Roaming' } as NodeJS.ProcessEnv, platform: 'win32' as const };

describe('isProtectedSaveRoot', () => {
  it.each([
    '/', '/home', '/home/jane', '/home/jane/', '/home/jane/Documents', '/home/jane/.local/share', '/home/jane/.config',
    '/home/jane/pfx/drive_c', '/home/jane/pfx/drive_c/users', '/home/jane/pfx/drive_c/users/steamuser',
    '/home/jane/pfx/drive_c/users/steamuser/Documents/My Games', '/home/jane/pfx/drive_c/users/steamuser/AppData/Roaming',
    '/home/jane/pfx/drive_c/users/steamuser/Saved Games', '', '  ',
  ])('linux: %j is protected', (p) => {
    expect(isProtectedSaveRoot(p, linux)).toBe(true);
  });

  it.each([
    '/home/jane/.local/share/Celeste', '/home/jane/pfx/drive_c/users/steamuser/Documents/My Games/Foo',
    '/home/jane/pfx/drive_c/users/steamuser/AppData/Roaming/Foo', '/mnt/games/Foo/saves',
  ])('linux: %j is allowed', (p) => {
    expect(isProtectedSaveRoot(p, linux)).toBe(false);
  });

  it.each(['C:\\', 'C:\\Users', 'c:\\users\\jane', 'C:\\Users\\Jane\\Documents', 'C:\\Users\\Jane\\Documents\\My Games',
    'C:\\Users\\Jane\\AppData\\LocalLow', 'C:\\Users\\Jane\\Saved Games', 'C:\\Users\\Public\\Documents', 'C:\\Users\\Jane\\AppData\\Roaming\\'])(
    'win32: %j is protected', (p) => {
      expect(isProtectedSaveRoot(p, win)).toBe(true);
    },
  );

  it('win32: a game folder below AppData is allowed', () => {
    expect(isProtectedSaveRoot('C:\\Users\\Jane\\AppData\\Roaming\\DarkSoulsIII', win)).toBe(false);
    expect(isProtectedSaveRoot('C:\\Users\\Jane\\Documents\\My Games\\Foo', win)).toBe(false);
  });
});
