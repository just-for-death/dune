/**
 * The ONE reader for the automatic update-check opt-in, Settings.updateCheckEnabled
 * (PL ruling 2026-10-28): manual checks (a click) always run; only automatic checks
 * (startup / electron-updater's own checks) need this flag, which is off by default.
 * Only a literal `true` enables. No legacy key is read.
 */
export function isUpdateCheckEnabled(settings: unknown): boolean {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return false;
  const s = settings as Record<string, unknown>;
  return s.updateCheckEnabled === true;
}
