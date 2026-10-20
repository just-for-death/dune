import type { DriveRow } from '../../services/driveSpace';

interface Props {
  rows: DriveRow[] | null;
  error: boolean;
  onRetry: () => void;
}

/** DUN-042: free space per drive from getDiskSpace(); unavailable drives say why in plain words. */
export function DriveSpaceList({ rows, error, onRetry }: Props) {
  if (error) {
    return (
      <div className="inline-error" role="alert">
        <span>Drive info unavailable.</span>
        <button type="button" className="btn btn-secondary btn-sm" onClick={onRetry}>Try again</button>
      </div>
    );
  }
  if (rows === null) return <p className="text-muted text-sm" role="status">Reading drives…</p>;
  if (rows.length === 0) return <p className="text-muted text-sm">No drives to show yet. Add a game or a scan location.</p>;
  return (
    <ul className="drive-list" aria-label="Drives">
      {rows.map(row => (
        <li key={row.key} className="storage-drive drive-row">
          <div className="storage-drive-head">
            <strong className="drive-title" title={row.paths.join('\n')}>{row.title}</strong>
            {row.available && <span className="muted">{row.freeText}</span>}
          </div>
          {row.available ? (
            <>
              <div
                className="storage-bar"
                role="meter"
                aria-label={`${row.title} used space`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={row.usedPercent}
                aria-valuetext={`${row.usedPercent}% used, ${row.freeText}`}
              >
                <div className="storage-bar-fill" style={{ width: `${row.usedPercent}%` }} />
              </div>
              <div className="storage-drive-meta">
                <span>{row.usedPercent}% used</span>
                <span>{row.totalText}</span>
              </div>
            </>
          ) : (
            <p className="drive-reason">{row.reasonText}</p>
          )}
        </li>
      ))}
    </ul>
  );
}
