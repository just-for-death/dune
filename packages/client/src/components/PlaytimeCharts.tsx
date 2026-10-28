import { useId } from 'react';
import type { PlaytimeGraphData, PlaytimeComparison } from '@dune/shared';
import { useI18n } from '../i18n/context';
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
  type PlaytimeBucket,
} from '../services/playtimeFormat';

interface Props {
  data: PlaytimeGraphData | null;
  comparison: PlaytimeComparison | null;
}

// DUN-049: each chart is one named image for assistive tech, with its data
// available as text (a visually hidden table, or the visible legend / labels).

// DUN-096: points are days or months (bucket); the ticks, axis title, data
// table and accessible name all say which.
function LineChart({ values, bucket }: { values: { date: string; minutes: number }[]; bucket: PlaytimeBucket }) {
  const { t, locale } = useI18n();
  if (values.length === 0) return <div className="empty-state">{t('playtime.noData')}</div>;
  const width = 520;
  const plotHeight = 180;
  const height = plotHeight + 40;
  const max = Math.max(...values.map((item) => item.minutes), 1);
  const xOf = (index: number) => (index / Math.max(1, values.length - 1)) * width;
  const points = values.map((item, index) => `${xOf(index)},${plotHeight - (item.minutes / max) * (plotHeight - 20)}`).join(' ');
  const texts = bucketTexts(bucket, t);
  const ticks = tickIndexes(values.length);
  return (
    <>
      <svg viewBox={`0 0 ${width} ${height}`} className="chart-svg" role="img" aria-label={lineChartLabel(values, t, bucket, locale)}>
        <polyline points={points} fill="none" stroke="var(--sand)" strokeWidth="3" />
        <g className="chart-axis" fill="var(--muted)" fontSize="12">
          {ticks.map((index, i) => (
            <text
              key={values[index].date}
              className="chart-tick"
              x={xOf(index)}
              y={plotHeight + 16}
              textAnchor={ticks.length === 1 ? 'start' : i === 0 ? 'start' : i === ticks.length - 1 ? 'end' : 'middle'}
            >
              {formatBucketDate(values[index].date, bucket, locale, 'tick')}
            </text>
          ))}
          <text className="chart-axis-title" x={width / 2} y={plotHeight + 36} textAnchor="middle">{texts.axis}</text>
        </g>
      </svg>
      <table className="sr-only">
        <caption>{texts.caption}</caption>
        <thead><tr><th scope="col">{texts.column}</th><th scope="col">{t('playtime.tableTotal')}</th></tr></thead>
        <tbody>
          {values.map((item) => (
            <tr key={item.date}><td>{formatBucketDate(item.date, bucket, locale)}</td><td>{formatMinutes(item.minutes)}</td></tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function BarChart({ values }: { values: { game: string; minutes: number }[] }) {
  const { t } = useI18n();
  if (values.length === 0) return <div className="empty-state">{t('playtime.noData')}</div>;
  const max = Math.max(...values.map((item) => item.minutes), 1);
  return (
    <ul className="bar-chart">
      {values.map((item) => (
        <li key={item.game} className="bar-row">
          <span className="bar-label">{item.game}</span>
          <span className="bar-track" aria-hidden="true"><span className="bar-fill" style={{ width: `${(Math.max(item.minutes, 0) / max) * 100}%` }} /></span>
          <span className="bar-value">{formatMinutes(item.minutes)}</span>
        </li>
      ))}
    </ul>
  );
}

function PieChart({ values }: { values: { game: string; minutes: number; percentage: number }[] }) {
  const { t, tc } = useI18n();
  if (values.length === 0) return <div className="empty-state">{t('playtime.noData')}</div>;
  const radius = 70;
  const circumference = 2 * Math.PI * radius;
  const offsets = values.reduce<number[]>((acc, _item, index) => {
    const previous = index === 0 ? 0 : acc[index - 1];
    acc.push(previous + ((values[index - 1]?.percentage || 0) / 100) * circumference);
    return acc;
  }, []);
  return (
    <div className="pie-layout">
      <svg viewBox="0 0 200 200" className="chart-svg pie-chart" role="img" aria-label={pieChartLabel(values, t, tc)}>
        {values.map((item, index) => {
          const dash = ((item.percentage || 0) / 100) * circumference;
          const offset = offsets[index] || 0;
          return (
            <circle key={item.game} cx="100" cy="100" r={radius} fill="none" stroke={sliceColor(index)} strokeWidth="28" strokeDasharray={`${dash} ${circumference - dash}`} strokeDashoffset={-offset} />
          );
        })}
        <text x="100" y="105" textAnchor="middle" fill="var(--text)" fontSize="14">{tc('playtime.pieGames', values.length)}</text>
      </svg>
      <ul className="chart-legend" aria-label={t('playtime.legend')}>
        {values.map((item, index) => (
          <li key={item.game} className="chart-legend-item">
            <span className="chart-swatch" style={{ background: sliceColor(index) }} aria-hidden="true" />
            <span className="chart-legend-name">{item.game}</span>
            <span className="chart-legend-value">{formatMinutes(item.minutes)} ({formatShare(item.percentage)})</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function PlaytimeCharts({ data, comparison }: Props) {
  const id = useId();
  const { t } = useI18n();
  const sections = [
    { key: 'line', title: t('playtime.chartLine'), body: <LineChart values={data?.line ?? []} bucket={playtimeBucket(data)} /> },
    { key: 'bar', title: t('playtime.chartBar'), body: <BarChart values={data?.bar ?? []} /> },
    { key: 'pie', title: t('playtime.chartPie'), body: <PieChart values={data?.pie ?? []} /> },
  ];
  return (
    <div className="playtime-charts">
      {sections.map((section) => (
        <section key={section.key} className="chart-section" aria-labelledby={`${id}-${section.key}`}>
          <h3 className="card-title" id={`${id}-${section.key}`}>{section.title}</h3>
          {section.body}
        </section>
      ))}
      {comparison && (
        <section className="chart-section" aria-labelledby={`${id}-comparison`}>
          <h3 className="card-title" id={`${id}-comparison`}>{t('playtime.comparison')}</h3>
          <div className="stats-row">
            <div className="stat-card"><div className="stat-value">{formatMinutes(comparison.current.totalMinutes)}</div><div className="stat-label">{t('playtime.current')}</div></div>
            <div className="stat-card"><div className="stat-value">{formatMinutes(comparison.previous.totalMinutes)}</div><div className="stat-label">{t('playtime.previous')}</div></div>
            <div className="stat-card">
              <div className="stat-value">
                <span aria-hidden="true">{formatChange(comparison.current.totalMinutes, comparison.previous.totalMinutes, t)}</span>
                <span className="sr-only">{describeChange(comparison.current.totalMinutes, comparison.previous.totalMinutes, t)}</span>
              </div>
              <div className="stat-label">{t('playtime.change')}</div>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
