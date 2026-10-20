import type { StorageEntry } from '@dune/shared';

interface Drive {
  name: string;
  totalBytes: number;
  freeBytes: number;
}

interface Props {
  drives: Drive[];
  entries: StorageEntry[];
}

export function StorageManager({ drives, entries }: Props) {
  return (
    <div className="storage-manager">
      <div className="storage-drives">
        {drives.map((drive) => {
          const used = Math.max(0, drive.totalBytes - drive.freeBytes);
          const percent = drive.totalBytes > 0 ? (used / drive.totalBytes) * 100 : 0;
          return (
            <div key={drive.name} className="storage-drive">
              <div className="storage-drive-head">
                <strong>{drive.name}</strong>
                <span className="muted">{(drive.freeBytes / 1024 / 1024 / 1024).toFixed(1)} GB free</span>
              </div>
              <div className="storage-bar">
                <div className="storage-bar-fill" style={{ width: `${Math.min(100, percent)}%` }} />
              </div>
              <div className="storage-drive-meta">
                <span>{(used / 1024 / 1024 / 1024).toFixed(1)} GB games/other</span>
                <span>{(drive.totalBytes / 1024 / 1024 / 1024).toFixed(0)} GB total</span>
              </div>
            </div>
          );
        })}
      </div>

      <table className="data-table">
        <thead>
          <tr>
            <th>Game</th>
            <th>Save size</th>
            <th>Cache size</th>
            <th>Last played</th>
            <th>Drive</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <tr key={entry.gameId}>
              <td>Game #{entry.gameId}</td>
              <td>{(entry.saveBytes / 1024 / 1024).toFixed(1)} MB</td>
              <td>{(entry.cacheBytes / 1024 / 1024).toFixed(1)} MB</td>
              <td>{entry.lastPlayed ? new Date(entry.lastPlayed).toLocaleDateString() : 'Never'}</td>
              <td>{entry.drive}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
