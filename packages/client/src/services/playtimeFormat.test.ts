import { describe, expect, it } from 'vitest';
import { describeChange, formatChange, formatMinutes, formatShare, lineChartLabel, pieChartLabel, sliceColor } from './playtimeFormat';

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
