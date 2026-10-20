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

const EM_DASH = '\u2014';

/**
 * Change from the previous period as a whole percentage with an explicit sign
 * ("+25%", "-10%", "0%"). With no previous playtime there is no percentage:
 * "New" if there is playtime now, otherwise an em dash. Never NaN or Infinity.
 */
export function formatChange(current: number, previous: number): string {
  const now = Number.isFinite(current) && current > 0 ? current : 0;
  const before = Number.isFinite(previous) && previous > 0 ? previous : 0;
  if (before === 0) return now > 0 ? 'New' : EM_DASH;
  const pct = Math.round(((now - before) / before) * 100);
  if (pct === 0) return '0%';
  return pct > 0 ? `+${pct}%` : `-${Math.abs(pct)}%`;
}

/** Spoken form of formatChange for an accessible name. */
export function describeChange(current: number, previous: number): string {
  const change = formatChange(current, previous);
  if (change === 'New') return 'new this period';
  if (change === EM_DASH) return 'no playtime in either period';
  if (change === '0%') return 'no change';
  return change.startsWith('+') ? `up ${change.slice(1)}` : `down ${change.slice(1)}`;
}

/** Whole percentage for a share, never NaN ("12%"). */
export function formatShare(percentage: number): string {
  return `${Number.isFinite(percentage) && percentage > 0 ? Math.round(percentage) : 0}%`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Accessible name of the cumulative line chart. */
export function lineChartLabel(values: readonly { date: string; minutes: number }[]): string {
  if (values.length === 0) return 'Cumulative playtime: no data.';
  const first = values[0];
  const last = values[values.length - 1];
  return `Cumulative playtime from ${first.date} to ${last.date}, reaching ${formatMinutes(last.minutes)}.`;
}

/** Accessible name of the distribution (pie) chart. */
export function pieChartLabel(values: readonly { game: string; minutes: number; percentage: number }[]): string {
  if (values.length === 0) return 'Playtime distribution: no data.';
  const top = values.reduce((a, b) => (b.minutes > a.minutes ? b : a));
  return `Playtime distribution across ${plural(values.length, 'game')}. Most played: ${top.game}, ${formatShare(top.percentage)}.`;
}

/** Colour of slice `index`; the legend swatch uses the same value. */
export function sliceColor(index: number): string {
  return `hsl(${(index * 47) % 360}, 70%, 65%)`;
}
