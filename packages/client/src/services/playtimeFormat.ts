/**
 * Pure formatting for playtime numbers (DUN-049): durations, period change
 * and the text alternatives of the playtime charts.
 */

/** Minutes as "45m", "2h" or "2h 5m". Negative, NaN or Infinity count as 0. */
export function formatMinutes(min: number): string {
  const total = Number.isFinite(min) && min > 0 ? Math.round(min) : 0;
  if (total < 60) return `${total}m`;
  const h = Math.floor(total / 60);
  const m = total % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

import type { PlaytimeGraphData } from '@dune/shared';
import { DEFAULT_LOCALE, defaultPluralTranslator, defaultTranslator, type Locale, type MessageKey, type PluralTranslator, type Translator } from '../i18n';

const EM_DASH = '\u2014';

type Change = { kind: 'new' | 'none' | 'same' } | { kind: 'up' | 'down'; pct: number };

function changeOf(current: number, previous: number): Change {
  const now = Number.isFinite(current) && current > 0 ? current : 0;
  const before = Number.isFinite(previous) && previous > 0 ? previous : 0;
  if (before === 0) return { kind: now > 0 ? 'new' : 'none' };
  const pct = Math.round(((now - before) / before) * 100);
  if (pct === 0) return { kind: 'same' };
  return pct > 0 ? { kind: 'up', pct } : { kind: 'down', pct: Math.abs(pct) };
}

/**
 * Change from the previous period as a whole percentage with an explicit sign
 * ("+25%", "-10%", "0%"). With no previous playtime there is no percentage:
 * "New" if there is playtime now, otherwise an em dash. Never NaN or Infinity.
 */
export function formatChange(current: number, previous: number, t: Translator = defaultTranslator): string {
  const change = changeOf(current, previous);
  switch (change.kind) {
    case 'new': return t('playtime.changeNew');
    case 'none': return EM_DASH;
    case 'same': return '0%';
    case 'up': return `+${change.pct}%`;
    case 'down': return `-${change.pct}%`;
  }
}

/** Spoken form of formatChange for an accessible name. */
export function describeChange(current: number, previous: number, t: Translator = defaultTranslator): string {
  const change = changeOf(current, previous);
  switch (change.kind) {
    case 'new': return t('playtime.changeNewSpoken');
    case 'none': return t('playtime.changeNoneSpoken');
    case 'same': return t('playtime.changeSameSpoken');
    case 'up': return t('playtime.changeUpSpoken', { pct: change.pct });
    case 'down': return t('playtime.changeDownSpoken', { pct: change.pct });
  }
}

/** Whole percentage for a share, never NaN ("12%"). */
export function formatShare(percentage: number): string {
  return `${Number.isFinite(percentage) && percentage > 0 ? Math.round(percentage) : 0}%`;
}

/** DUN-096: what one line-chart point covers. */
export type PlaytimeBucket = 'day' | 'month';

/** The graph's bucket; a missing or unknown value (older server) means 'day'. */
export function playtimeBucket(data: Pick<PlaytimeGraphData, 'bucket'> | null | undefined): PlaytimeBucket {
  return data?.bucket === 'month' ? 'month' : 'day';
}

/**
 * A point's date as text. Day buckets keep the server's YYYY-MM-DD as is.
 * Month buckets (YYYY-MM-01) use the locale's month and year: 'tick' is
 * short ("Oct 2026"), 'full' is long ("October 2026", "octubre de 2026").
 * A date that does not parse is returned unchanged.
 */
export function formatBucketDate(date: string, bucket: PlaytimeBucket, locale: Locale = DEFAULT_LOCALE, style: 'tick' | 'full' = 'full'): string {
  if (bucket === 'day') return date;
  const month = /^(\d{4})-(\d{2})/.exec(date);
  if (!month) return date;
  const at = Date.UTC(Number(month[1]), Number(month[2]) - 1, 1);
  if (!Number.isFinite(at)) return date;
  return new Intl.DateTimeFormat(locale, { month: style === 'tick' ? 'short' : 'long', year: 'numeric', timeZone: 'UTC' }).format(at);
}

/** Up to `max` evenly spaced point indexes for axis ticks, always first and last. */
export function tickIndexes(count: number, max = 4): number[] {
  if (!Number.isInteger(count) || count <= 0) return [];
  if (count === 1 || max <= 1) return [0];
  const steps = Math.min(count, Math.max(2, Math.floor(max))) - 1;
  const out: number[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const index = Math.round((i * (count - 1)) / steps);
    if (out[out.length - 1] !== index) out.push(index);
  }
  return out;
}

const BUCKET_KEYS: Record<PlaytimeBucket, { axis: MessageKey; column: MessageKey; caption: MessageKey; label: MessageKey }> = {
  day: { axis: 'playtime.axisDay', column: 'playtime.tableDate', caption: 'playtime.tableCaption', label: 'playtime.lineLabel' },
  month: { axis: 'playtime.axisMonth', column: 'playtime.tableMonth', caption: 'playtime.tableCaptionMonth', label: 'playtime.lineLabelMonth' },
};

/** Axis title, data-table column header and caption for a bucket. */
export function bucketTexts(bucket: PlaytimeBucket, t: Translator = defaultTranslator): { axis: string; column: string; caption: string } {
  const keys = BUCKET_KEYS[bucket];
  return { axis: t(keys.axis), column: t(keys.column), caption: t(keys.caption) };
}

/** Accessible name of the cumulative line chart ('day' keeps the YYYY-MM-DD text). */
export function lineChartLabel(
  values: readonly { date: string; minutes: number }[],
  t: Translator = defaultTranslator,
  bucket: PlaytimeBucket = 'day',
  locale: Locale = DEFAULT_LOCALE,
): string {
  if (values.length === 0) return t('playtime.lineEmpty');
  const first = values[0];
  const last = values[values.length - 1];
  return t(BUCKET_KEYS[bucket].label, {
    from: formatBucketDate(first.date, bucket, locale),
    to: formatBucketDate(last.date, bucket, locale),
    total: formatMinutes(last.minutes),
  });
}

/** Accessible name of the distribution (pie) chart. */
export function pieChartLabel(
  values: readonly { game: string; minutes: number; percentage: number }[],
  t: Translator = defaultTranslator,
  tc: PluralTranslator = defaultPluralTranslator,
): string {
  if (values.length === 0) return t('playtime.pieEmpty');
  const top = values.reduce((a, b) => (b.minutes > a.minutes ? b : a));
  return tc('playtime.pieLabel', values.length, { game: top.game, share: formatShare(top.percentage) });
}

/** Colour of slice `index`; the legend swatch uses the same value. */
export function sliceColor(index: number): string {
  return `hsl(${(index * 47) % 360}, 70%, 65%)`;
}
