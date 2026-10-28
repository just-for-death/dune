/**
 * DUN-054: shared size and date formatting for the renderer.
 */
import { DEFAULT_LOCALE, defaultTranslator, type Locale, type Translator } from '../i18n';

/** Bytes as "512 B", "20.0 KB", "1.5 GB". Negative, NaN or Infinity count as 0. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

/**
 * A timestamp in the locale's date and time. Empty or "Never" reads as never;
 * a value that does not parse is returned unchanged (never "Invalid Date").
 */
export function formatDate(iso: string | null | undefined, locale: Locale = DEFAULT_LOCALE, t: Translator = defaultTranslator): string {
  if (!iso || iso === 'Never') return t('common.never');
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(locale);
}
