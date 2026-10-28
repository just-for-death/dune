// Structured client errors (DUN-061, DUN-086/087/088/093). REST answers
// `status` with exactly `{ error, code }` (see apiErrorBody).

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export function isApiError(err: unknown): err is ApiError {
  return err instanceof ApiError;
}

/** The REST error body contract: exactly `{ error, code }`. */
export function apiErrorBody(err: ApiError): { error: string; code: string } {
  return { error: err.message, code: err.code };
}

export function gameNotFound(): ApiError {
  return new ApiError(404, 'GAME_NOT_FOUND', 'Game not found');
}

export function versionNotFound(): ApiError {
  return new ApiError(404, 'VERSION_NOT_FOUND', 'Version not found');
}

export function conflictNotFound(): ApiError {
  return new ApiError(404, 'CONFLICT_NOT_FOUND', 'Conflict not found');
}

// ── DUN-061: launch fields are per-device and never sync ────────────────────

/** Explicit launch/exec field names (compared case-insensitively). */
export const LAUNCH_FIELDS = [
  'executable', 'exe', 'exec', 'execPath', 'executablePath', 'binary', 'binaryPath',
  'command', 'cmd', 'commandLine', 'emulator', 'emulatorPath', 'emulatorCommand',
  'winePrefix', 'wine', 'winePath', 'protonPath', 'proton', 'protonVersion', 'compatTool',
  'args', 'argv', 'arguments', 'launchArgs', 'launchArguments', 'launchOptions', 'launchCommand',
  'launcher', 'launcherPath', 'env', 'envVars', 'environment', 'environmentVariables',
  'cwd', 'workingDir', 'workingDirectory', 'workDir', 'startIn', 'wrapper', 'preLaunch', 'postLaunch',
] as const;

const LAUNCH_SET = new Set(LAUNCH_FIELDS.map((f) => f.toLowerCase()));
/** "Any similar exec field": launch*, wine*, proton*, emulator*, *Executable, *Args, *Env. */
const LAUNCH_PATTERN = /^(launch|wine|proton|emulator|exec)|(executable|args|arguments|env|cwd)$/i;

export function isLaunchField(key: string): boolean {
  return LAUNCH_SET.has(key.toLowerCase()) || LAUNCH_PATTERN.test(key);
}

/** Launch-field keys present on `obj` (top level only). */
export function findLaunchFields(obj: unknown): string[] {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return [];
  return Object.keys(obj).filter(isLaunchField);
}

export class LaunchFieldError extends ApiError {
  readonly fields: string[];
  constructor(fields: string[]) {
    super(400, 'LAUNCH_FIELD_NOT_ALLOWED', `Launch fields are device-local and cannot be sent to the server: ${fields.join(', ')}`);
    this.name = 'LaunchFieldError';
    this.fields = fields;
  }
}

/** Throw LaunchFieldError if `obj` (or a nested `game` object) carries launch fields. */
export function assertNoLaunchFields(obj: unknown): void {
  const found = findLaunchFields(obj);
  const nested = obj && typeof obj === 'object' ? (obj as Record<string, unknown>).game : undefined;
  found.push(...findLaunchFields(nested).map((k) => `game.${k}`));
  if (found.length > 0) throw new LaunchFieldError(found);
}
