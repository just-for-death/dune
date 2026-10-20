import type { PlaytimeGraphData, PlaytimeComparison } from '@dune/shared';

interface Props {
  data: PlaytimeGraphData | null;
  comparison: PlaytimeComparison | null;
}

function LineChart({ values }: { values: { date: string; minutes: number }[] }) {
  if (values.length === 0) return <div className="empty-state">No playtime data.</div>;
  const width = 520;
  const height = 180;
  const max = Math.max(...values.map((item) => item.minutes), 1);
  const points = values.map((item, index) => `${(index / Math.max(1, values.length - 1)) * width},${height - (item.minutes / max) * (height - 20)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="chart-svg">
      <polyline points={points} fill="none" stroke="var(--sand)" strokeWidth="3" />
    </svg>
  );
}

function BarChart({ values }: { values: { game: string; minutes: number }[] }) {
  if (values.length === 0) return <div className="empty-state">No playtime data.</div>;
  const max = Math.max(...values.map((item) => item.minutes), 1);
  return (
    <div className="bar-chart">
      {values.map((item) => (
        <div key={item.game} className="bar-row">
          <span className="bar-label">{item.game}</span>
          <div className="bar-track"><div className="bar-fill" style={{ width: `${(item.minutes / max) * 100}%` }} /></div>
          <span className="muted">{item.minutes}m</span>
        </div>
      ))}
    </div>
  );
}

function PieChart({ values }: { values: { game: string; minutes: number; percentage: number }[] }) {
  if (values.length === 0) return <div className="empty-state">No playtime data.</div>;
  const radius = 70;
  const circumference = 2 * Math.PI * radius;
  const offsets = values.reduce<number[]>((acc, _item, index) => {
    const previous = index === 0 ? 0 : acc[index - 1];
    acc.push(previous + ((values[index - 1]?.percentage || 0) / 100) * circumference);
    return acc;
  }, []);
  return (
    <svg viewBox="0 0 200 200" className="chart-svg pie-chart">
      {values.map((item, index) => {
        const dash = (item.percentage / 100) * circumference;
        const offset = offsets[index] || 0;
        return (
          <circle key={item.game} cx="100" cy="100" r={radius} fill="none" stroke={`hsl(${index * 47}, 70%, 55%)`} strokeWidth="28" strokeDasharray={`${dash} ${circumference - dash}`} strokeDashoffset={-offset} />
        );
      })}
      <text x="100" y="105" textAnchor="middle" fill="var(--text)" fontSize="14">{values.length} games</text>
    </svg>
  );
}

export function PlaytimeCharts({ data, comparison }: Props) {
  return (
    <div className="playtime-charts">
      <div className="card">
        <h3 className="card-title">Cumulative playtime</h3>
        <LineChart values={data?.line ?? []} />
      </div>
      <div className="card">
        <h3 className="card-title">Playtime by game</h3>
        <BarChart values={data?.bar ?? []} />
      </div>
      <div className="card">
        <h3 className="card-title">Distribution</h3>
        <PieChart values={data?.pie ?? []} />
      </div>
      {comparison && (
        <div className="card">
          <h3 className="card-title">Period comparison</h3>
          <div className="stats-row">
            <div className="stat-card"><div className="stat-value">{comparison.current.totalMinutes}m</div><div className="stat-label">Current</div></div>
            <div className="stat-card"><div className="stat-value">{comparison.previous.totalMinutes}m</div><div className="stat-label">Previous</div></div>
            <div className="stat-card"><div className="stat-value">{comparison.difference.percentage}%</div><div className="stat-label">Change</div></div>
          </div>
        </div>
      )}
    </div>
  );
}
