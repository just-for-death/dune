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

import { defaultPluralTranslator, defaultTranslator, type PluralTranslator, type Translator } from '../i18n';

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

/** Accessible name of the cumulative line chart. */
export function lineChartLabel(values: readonly { date: string; minutes: number }[], t: Translator = defaultTranslator): string {
  if (values.length === 0) return t('playtime.lineEmpty');
  const first = values[0];
  const last = values[values.length - 1];
  return t('playtime.lineLabel', { from: first.date, to: last.date, total: formatMinutes(last.minutes) });
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
