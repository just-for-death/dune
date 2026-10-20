/**
 * DUN-061: allow-list for per-game launch environment variables.
 *
 * Only env stored in main (per-game settings) may reach a spawned game, and
 * even then only known Wine / Proton / DXVK / overlay tuning knobs pass.
 * Anything that changes what code the loader, a runtime or a shell picks up
 * (LD_PRELOAD, DYLD_*, PATH, NODE_OPTIONS, GIO module paths, ...) is dropped,
 * as is any key that is not a plain upper-case env name.
 */

/**
 * Exact keys that may be set per game. No prefix matching: every name is
 * listed, and nothing that takes a path (PROTON_LOG_DIR, DXVK_LOG_PATH,
 * __GL_SHADER_DISK_CACHE_PATH, DXVK_CONFIG_FILE, ...) is on the list.
 */
const ALLOWED_KEYS: ReadonlySet<string> = new Set([
  // Wine
  'WINEDEBUG',
  'WINEESYNC',
  'WINEFSYNC',
  'WINEDLLOVERRIDES',
  'WINE_LARGE_ADDRESS_AWARE',
  'WINE_FULLSCREEN_FSR',
  'WINE_FULLSCREEN_FSR_STRENGTH',
  // DXVK / VKD3D
  'DXVK_HUD',
  'DXVK_ASYNC',
  'DXVK_FRAME_RATE',
  'DXVK_LOG_LEVEL',
  'DXVK_ENABLE_NVAPI',
  'DXVK_NVAPIHACK',
  'VKD3D_CONFIG',
  'VKD3D_DEBUG',
  'VKD3D_FEATURE_LEVEL',
  // Proton (boolean / level switches only)
  'PROTON_ENABLE_NVAPI',
  'PROTON_USE_WINED3D',
  'PROTON_NO_ESYNC',
  'PROTON_NO_FSYNC',
  'PROTON_NO_D3D11',
  'PROTON_NO_D3D12',
  'PROTON_ENABLE_WAYLAND',
  'PROTON_ENABLE_HDR',
  'PROTON_HIDE_NVIDIA_GPU',
  'PROTON_FORCE_LARGE_ADDRESS_AWARE',
  'PROTON_LOG',
  // NVIDIA GL (boolean switches only)
  '__GL_SHADER_DISK_CACHE',
  '__GL_THREADED_OPTIMIZATIONS',
  '__GL_SYNC_TO_VBLANK',
  '__GL_SHADER_DISK_CACHE_SKIP_CLEANUP',
  // Overlays / perf
  'MANGOHUD',
  'ENABLE_VKBASALT',
  'RADV_PERFTEST',
  'AMD_VULKAN_ICD',
  'SDL_VIDEODRIVER',
  'DRI_PRIME',
  'STEAM_COMPAT_CONFIG',
]);

/** Keys that are never accepted, even if a future allow-list entry would match. */
const BLOCKED_KEYS: ReadonlySet<string> = new Set([
  'PATH',
  'NODE_OPTIONS',
  'NODE_PATH',
  'ELECTRON_RUN_AS_NODE',
  'PYTHONPATH',
  'PYTHONSTARTUP',
  'PYTHONHOME',
  'PERL5LIB',
  'PERL5OPT',
  'RUBYLIB',
  'RUBYOPT',
  'BASH_ENV',
  'ENV',
  'SHELL',
  'IFS',
  'HOME',
  'GTK_PATH',
  'GTK_MODULES',
  'GTK_EXE_PREFIX',
  'GDK_PIXBUF_MODULE_FILE',
  'QT_PLUGIN_PATH',
  'VK_ICD_FILENAMES',
  'VK_DRIVER_FILES',
  'VK_LAYER_PATH',
  'VK_ADD_LAYER_PATH',
  'VK_INSTANCE_LAYERS',
  '__GLX_VENDOR_LIBRARY_NAME',
  '__EGL_VENDOR_LIBRARY_FILENAMES',
  'LIBGL_DRIVERS_PATH',
  // Main owns the prefix / runtime selection; per-game env cannot redirect it.
  'WINEPREFIX',
  'WINELOADER',
  'WINESERVER',
  'WINEDLLPATH',
  'PROTONPATH',
  'PROTON_PATH',
  'STEAM_COMPAT_DATA_PATH',
  'STEAM_COMPAT_CLIENT_INSTALL_PATH',
  'STEAM_COMPAT_TOOL_PATHS',
  // Path-valued tuning vars: never allowed.
  'PROTON_LOG_DIR',
  'DXVK_LOG_PATH',
  'DXVK_CONFIG_FILE',
  'DXVK_STATE_CACHE_PATH',
  'VKD3D_SHADER_CACHE_PATH',
  '__GL_SHADER_DISK_CACHE_PATH',
  'MANGOHUD_CONFIG', // inline config can set output_folder / log paths
  'MANGOHUD_CONFIGFILE',
]);

/** Prefix families that are never accepted (loader, runtimes, GIO/GTK module paths, Electron). */
const BLOCKED_PREFIXES: readonly string[] = [
  'LD_',
  'DYLD_',
  'GIO_',
  'GTK_',
  'GST_PLUGIN',
  'ELECTRON_',
  'NODE_',
  'NPM_',
  'PYTHON',
  'LUA_',
  'BASH_FUNC_',
];

/** Plain upper-case env name; rejects `=`, NUL, spaces, lower case and other shell metacharacters. */
const KEY_FORMAT = /^[A-Z_][A-Z0-9_]{0,63}$/;
const MAX_VALUE_LENGTH = 1024;

export function isBlockedEnvKey(key: string): boolean {
  return BLOCKED_KEYS.has(key) || BLOCKED_PREFIXES.some((prefix) => key.startsWith(prefix));
}

export function isAllowedEnvKey(key: unknown): key is string {
  if (typeof key !== 'string' || !KEY_FORMAT.test(key)) return false;
  if (isBlockedEnvKey(key)) return false;
  return ALLOWED_KEYS.has(key);
}

function isAllowedEnvValue(value: unknown): value is string {
  // eslint-disable-next-line no-control-regex
  return typeof value === 'string' && value.length <= MAX_VALUE_LENGTH && !/[\u0000\r\n]/.test(value);
}

/**
 * Returns only the allow-listed entries of `env` (a fresh object with no
 * prototype pollution). Non-object input yields `{}`.
 */
export function filterLaunchEnv(env: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!env || typeof env !== 'object' || Array.isArray(env)) return out;
  for (const [key, value] of Object.entries(env as Record<string, unknown>)) {
    if (isAllowedEnvKey(key) && isAllowedEnvValue(value)) out[key] = value;
  }
  return out;
}
