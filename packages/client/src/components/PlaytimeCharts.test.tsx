import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PlaytimeComparison, PlaytimeGraphData } from '@dune/shared';
import { PlaytimeCharts } from './PlaytimeCharts';
import { createPluralTranslator, createTranslator } from '../i18n';
import { I18nContext } from '../i18n/context';

const data: PlaytimeGraphData = {
  line: [{ date: '2026-10-01', minutes: 30 }, { date: '2026-10-02', minutes: 1234 }],
  bar: [{ game: 'Hades', minutes: 1234 }, { game: 'Celeste', minutes: 45 }],
  pie: [{ game: 'Hades', minutes: 1234, percentage: 96.5 }, { game: 'Celeste', minutes: 45, percentage: 3.5 }],
  heatmap: [],
  area: [],
};

const comparison = (current: number, previous: number): PlaytimeComparison => ({
  current: { period: 'month', totalMinutes: current, sessions: 1 },
  previous: { period: 'month', totalMinutes: previous, sessions: 1 },
  difference: { minutes: current - previous, percentage: previous === 0 ? Infinity : 0, sessions: 0 },
});

describe('PlaytimeCharts', () => {
  it('names each SVG chart as one image', () => {
    const html = renderToStaticMarkup(<PlaytimeCharts data={data} comparison={null} />);
    expect(html).toContain('role="img" aria-label="Cumulative playtime from 2026-10-01 to 2026-10-02, reaching 20h 34m."');
    expect(html).toContain('role="img" aria-label="Playtime distribution across 2 games. Most played: Hades, 97%."');
  });

  it('has a hidden data table for the line chart', () => {
    const html = renderToStaticMarkup(<PlaytimeCharts data={data} comparison={null} />);
    expect(html).toMatch(/<table class="sr-only"><caption>Cumulative playtime by date<\/caption>/);
    expect(html).toContain('<td>2026-10-02</td><td>20h 34m</td>');
  });

  it('formats bar values and shows a pie legend', () => {
    const html = renderToStaticMarkup(<PlaytimeCharts data={data} comparison={null} />);
    expect(html).toContain('<span class="bar-value">20h 34m</span>');
    expect(html).not.toContain('1234m');
    expect(html).toContain('<span class="chart-legend-name">Celeste</span><span class="chart-legend-value">45m (4%)</span>');
    expect(html).toMatch(/class="chart-swatch" style="background:hsl\(0, 70%, 65%\)" aria-hidden="true"/);
  });

  it('never nests cards', () => {
    const html = renderToStaticMarkup(<PlaytimeCharts data={data} comparison={comparison(120, 60)} />);
    expect(html).not.toMatch(/class="(?:[^"]* )?card[ "]/);
    expect(html.match(/<section class="chart-section"/g)).toHaveLength(4);
  });

  it('formats the comparison with a sign and without Infinity', () => {
    const up = renderToStaticMarkup(<PlaytimeCharts data={null} comparison={comparison(150, 100)} />);
    expect(up).toContain('<div class="stat-value">2h 30m</div>');
    expect(up).toContain('<span aria-hidden="true">+50%</span><span class="sr-only">up 50%</span>');
    const fresh = renderToStaticMarkup(<PlaytimeCharts data={null} comparison={comparison(30, 0)} />);
    expect(fresh).toContain('<span aria-hidden="true">New</span>');
    expect(fresh).not.toMatch(/Infinity|NaN/);
  });

  it('shows empty states without data', () => {
    const html = renderToStaticMarkup(<PlaytimeCharts data={null} comparison={null} />);
    expect(html.match(/No playtime data\./g)).toHaveLength(3);
    expect(html).not.toContain('role="img"');
  });

  it('labels day ticks and the axis when bucket is missing (today\'s behaviour)', () => {
    const html = renderToStaticMarkup(<PlaytimeCharts data={data} comparison={null} />);
    expect(html).toContain('<text class="chart-tick" x="0" y="196" text-anchor="start">2026-10-01</text>');
    expect(html).toContain('text-anchor="end">2026-10-02</text>');
    expect(html).toContain('<text class="chart-axis-title" x="260" y="216" text-anchor="middle">Day</text>');
    expect(html).toContain('<th scope="col">Date</th>');
  });

  it('labels month buckets by month in the title, ticks, axis and table', () => {
    const monthly: PlaytimeGraphData = { ...data, bucket: 'month', line: [{ date: '2025-11-01', minutes: 60 }, { date: '2026-10-01', minutes: 1234 }] };
    const html = renderToStaticMarkup(<PlaytimeCharts data={monthly} comparison={null} />);
    expect(html).toContain('role="img" aria-label="Cumulative playtime by month from November 2025 to October 2026, reaching 20h 34m."');
    expect(html).toContain('>Nov 2025</text>');
    expect(html).toContain('>Oct 2026</text>');
    expect(html).toContain('text-anchor="middle">Month</text>');
    expect(html).toContain('<caption>Cumulative playtime by month</caption>');
    expect(html).toContain('<td>October 2026</td><td>20h 34m</td>');
  });

  it('formats months in the current i18n language', () => {
    const monthly: PlaytimeGraphData = { ...data, bucket: 'month', line: [{ date: '2026-10-01', minutes: 60 }] };
    const html = renderToStaticMarkup(
      <I18nContext.Provider value={{ locale: 'es', setLocale: () => {}, t: createTranslator('es'), tc: createPluralTranslator('es') }}>
        <PlaytimeCharts data={monthly} comparison={null} />
      </I18nContext.Provider>,
    );
    expect(html).toContain('aria-label="Tiempo de juego acumulado por mes de octubre de 2026 a octubre de 2026, hasta 1h."');
    expect(html).toContain('<td>octubre de 2026</td>');
    expect(html).toContain('text-anchor="middle">Mes</text>');
  });
});

