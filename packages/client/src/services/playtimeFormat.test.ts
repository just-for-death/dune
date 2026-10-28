import { describe, expect, it } from 'vitest';
import { createTranslator } from '../i18n';
import {
  bucketTexts,
  describeChange,
  formatBucketDate,
  formatChange,
  formatMinutes,
  formatShare,
  lineChartLabel,
  pieChartLabel,
  playtimeBucket,
  sliceColor,
  tickIndexes,
} from './playtimeFormat';

describe('formatMinutes', () => {
  it('formats minutes and hours', () => {
    expect(formatMinutes(0)).toBe('0m');
    expect(formatMinutes(45)).toBe('45m');
    expect(formatMinutes(60)).toBe('1h');
    expect(formatMinutes(1234)).toBe('20h 34m');
  });
  it('never shows NaN, negatives or fractions', () => {
    expect(formatMinutes(Number.NaN)).toBe('0m');
    expect(formatMinutes(Number.POSITIVE_INFINITY)).toBe('0m');
    expect(formatMinutes(-5)).toBe('0m');
    expect(formatMinutes(59.6)).toBe('1h');
  });
});

describe('formatChange', () => {
  it('rounds and always signs the change', () => {
    expect(formatChange(125, 100)).toBe('+25%');
    expect(formatChange(90, 100)).toBe('-10%');
    expect(formatChange(100, 300)).toBe('-67%');
    expect(formatChange(200, 300)).toBe('-33%');
    expect(formatChange(100, 100)).toBe('0%');
    expect(formatChange(1001, 1000)).toBe('0%');
  });
  it('shows New or an em dash instead of Infinity / NaN', () => {
    expect(formatChange(30, 0)).toBe('New');
    expect(formatChange(0, 0)).toBe('\u2014');
    expect(formatChange(Number.NaN, Number.NaN)).toBe('\u2014');
    expect(formatChange(10, Number.NaN)).toBe('New');
    expect(formatChange(0, 50)).toBe('-100%');
  });
  it('has a spoken form', () => {
    expect(describeChange(125, 100)).toBe('up 25%');
    expect(describeChange(90, 100)).toBe('down 10%');
    expect(describeChange(100, 100)).toBe('no change');
    expect(describeChange(5, 0)).toBe('new this period');
    expect(describeChange(0, 0)).toBe('no playtime in either period');
  });
});

describe('chart labels', () => {
  it('summarises the line chart', () => {
    expect(lineChartLabel([])).toBe('Cumulative playtime: no data.');
    expect(lineChartLabel([{ date: '2026-10-01', minutes: 30 }, { date: '2026-10-02', minutes: 150 }]))
      .toBe('Cumulative playtime from 2026-10-01 to 2026-10-02, reaching 2h 30m.');
  });
  it('summarises the pie chart with the top game', () => {
    expect(pieChartLabel([])).toBe('Playtime distribution: no data.');
    expect(pieChartLabel([
      { game: 'Hades', minutes: 30, percentage: 25.4 },
      { game: 'Celeste', minutes: 90, percentage: 74.6 },
    ])).toBe('Playtime distribution across 2 games. Most played: Celeste, 75%.');
  });
  it('formats shares and slice colours', () => {
    expect(formatShare(33.4)).toBe('33%');
    expect(formatShare(Number.NaN)).toBe('0%');
    expect(sliceColor(0)).toBe('hsl(0, 70%, 65%)');
    expect(sliceColor(8)).toBe('hsl(16, 70%, 65%)');
  });
});

describe('DUN-096 buckets', () => {
  it('defaults to day when bucket is missing or unknown', () => {
    expect(playtimeBucket(null)).toBe('day');
    expect(playtimeBucket({})).toBe('day');
    expect(playtimeBucket({ bucket: 'day' })).toBe('day');
    expect(playtimeBucket({ bucket: 'month' })).toBe('month');
    expect(playtimeBucket({ bucket: 'week' as never })).toBe('day');
  });

  it('keeps day dates as sent and formats months per locale', () => {
    expect(formatBucketDate('2026-10-05', 'day', 'es', 'tick')).toBe('2026-10-05');
    expect(formatBucketDate('2026-10-01', 'month', 'en')).toBe('October 2026');
    expect(formatBucketDate('2026-10-01', 'month', 'en', 'tick')).toBe('Oct 2026');
    expect(formatBucketDate('2026-10-01', 'month', 'es')).toBe('octubre de 2026');
    // UTC, so the first of the month never slips into the previous month.
    expect(formatBucketDate('2026-01-01', 'month', 'en')).toBe('January 2026');
    expect(formatBucketDate('garbage', 'month', 'en')).toBe('garbage');
  });

  it('picks evenly spaced ticks including first and last', () => {
    expect(tickIndexes(0)).toEqual([]);
    expect(tickIndexes(1)).toEqual([0]);
    expect(tickIndexes(2)).toEqual([0, 1]);
    expect(tickIndexes(3)).toEqual([0, 1, 2]);
    expect(tickIndexes(10)).toEqual([0, 3, 6, 9]);
    expect(tickIndexes(366)).toEqual([0, 122, 243, 365]);
    expect(tickIndexes(Number.NaN)).toEqual([]);
  });

  it('names the axis, column and caption by bucket', () => {
    expect(bucketTexts('day')).toEqual({ axis: 'Day', column: 'Date', caption: 'Cumulative playtime by date' });
    expect(bucketTexts('month')).toEqual({ axis: 'Month', column: 'Month', caption: 'Cumulative playtime by month' });
    expect(bucketTexts('month', createTranslator('es'))).toEqual({ axis: 'Mes', column: 'Mes', caption: 'Tiempo de juego acumulado por mes' });
  });

  it('summarises a monthly line chart with month names', () => {
    const values = [{ date: '2025-01-01', minutes: 30 }, { date: '2026-10-01', minutes: 150 }];
    expect(lineChartLabel(values, undefined, 'month', 'en'))
      .toBe('Cumulative playtime by month from January 2025 to October 2026, reaching 2h 30m.');
    expect(lineChartLabel(values, createTranslator('es'), 'month', 'es'))
      .toBe('Tiempo de juego acumulado por mes de enero de 2025 a octubre de 2026, hasta 2h 30m.');
    expect(lineChartLabel(values, undefined, 'day')).toBe('Cumulative playtime from 2025-01-01 to 2026-10-01, reaching 2h 30m.');
  });
});
