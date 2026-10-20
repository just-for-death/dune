import { describe, it, expect } from 'vitest';
import { filterLaunchEnv, isAllowedEnvKey, isBlockedEnvKey } from './envAllowlist.js';

describe('DUN-061 launch env allow-list', () => {
  const blocked = [
    'LD_PRELOAD', 'LD_LIBRARY_PATH', 'LD_AUDIT', 'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH',
    'PATH', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'PYTHONPATH', 'BASH_ENV', 'ENV',
    'GIO_MODULE_DIR', 'GIO_EXTRA_MODULES', 'GTK_PATH', 'GTK_MODULES', 'VK_LAYER_PATH',
    'WINEPREFIX', 'WINELOADER', 'WINEDLLPATH', 'PROTONPATH', 'BASH_FUNC_x%%',
    // Path-valued tuning vars.
    'PROTON_LOG_DIR', 'DXVK_LOG_PATH', 'DXVK_CONFIG_FILE', '__GL_SHADER_DISK_CACHE_PATH', 'MANGOHUD_CONFIGFILE', 'MANGOHUD_CONFIG',
  ];

  it.each(blocked)('blocks %s', (key) => {
    expect(isAllowedEnvKey(key)).toBe(false);
    expect(filterLaunchEnv({ [key]: '/tmp/dune061-evil.so' })).toEqual({});
  });

  it('flags loader and runtime families as blocked', () => {
    for (const key of ['LD_ANYTHING', 'DYLD_FOO', 'GIO_FOO', 'ELECTRON_FOO', 'NODE_FOO']) {
      expect(isBlockedEnvKey(key)).toBe(true);
    }
  });

  it('passes known Wine / Proton / DXVK / overlay vars', () => {
    const env = {
      WINEDEBUG: '-all',
      WINEESYNC: '1',
      WINEFSYNC: '1',
      DXVK_HUD: 'fps',
      PROTON_USE_WINED3D: '1',
      PROTON_ENABLE_NVAPI: '1',
      MANGOHUD: '1',
      __GL_SHADER_DISK_CACHE: '1',
      __GL_THREADED_OPTIMIZATIONS: '1',
    };
    expect(filterLaunchEnv(env)).toEqual(env);
  });

  it('only allow-lists explicit keys, not arbitrary upper-case names', () => {
    expect(isAllowedEnvKey('HOME')).toBe(false);
    expect(isAllowedEnvKey('SOME_RANDOM_VAR')).toBe(false);
    expect(isAllowedEnvKey('PROTON_')).toBe(false);
    expect(isAllowedEnvKey('DXVK_CONFIG_FILE')).toBe(false);
  });

  it('has no prefix matching: unknown PROTON_* / __GL_* names are rejected', () => {
    for (const key of ['PROTON_LOG_DIR', 'PROTON_SOMETHING_NEW', '__GL_SHADER_DISK_CACHE_PATH', '__GL_ANYTHING', 'DXVK_ANYTHING']) {
      expect(isAllowedEnvKey(key)).toBe(false);
    }
    expect(filterLaunchEnv({ PROTON_LOG_DIR: '/tmp/dune061-logs', PROTON_LOG: '1' })).toEqual({ PROTON_LOG: '1' });
  });

  it('rejects malformed keys', () => {
    for (const key of ['', 'winedebug', 'WINE DEBUG', 'WINEDEBUG=1', 'WINEDEBUG\u0000', '1WINE', `PROTON_${'X'.repeat(80)}`]) {
      expect(isAllowedEnvKey(key)).toBe(false);
    }
  });

  it('drops non-string, multi-line and oversize values', () => {
    expect(filterLaunchEnv({
      WINEDEBUG: 1,
      WINEESYNC: 'a\nLD_PRELOAD=/x.so',
      WINEFSYNC: 'x\u0000y',
      DXVK_HUD: 'x'.repeat(2000),
      MANGOHUD: '1',
    })).toEqual({ MANGOHUD: '1' });
  });

  it('returns an empty object for non-object input and ignores __proto__', () => {
    expect(filterLaunchEnv(undefined)).toEqual({});
    expect(filterLaunchEnv('LD_PRELOAD=/x.so')).toEqual({});
    expect(filterLaunchEnv(['WINEDEBUG'])).toEqual({});
    const polluted = JSON.parse('{"__proto__": {"LD_PRELOAD": "/x.so"}, "WINEDEBUG": "-all"}');
    const out = filterLaunchEnv(polluted);
    expect(out).toEqual({ WINEDEBUG: '-all' });
    expect((out as Record<string, unknown>).LD_PRELOAD).toBeUndefined();
  });
});
