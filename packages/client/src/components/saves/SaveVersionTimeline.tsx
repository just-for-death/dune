import type { SaveVersion } from '@dune/shared';

interface Props {
  versions: SaveVersion[];
  onRestore?: (versionId: string) => void;
}

export function SaveVersionTimeline({ versions, onRestore }: Props) {
  if (versions.length === 0) {
    return (
      <div className="empty-state">
        <p>No saved versions yet.</p>
        <p className="muted">Run a sync to create the first version.</p>
      </div>
    );
  }

  return (
    <ol className="save-timeline">
      {versions.map((version, index) => (
        <li key={version.id} className={`save-version ${index === 0 ? 'save-version-latest' : ''}`}>
          <div className="save-version-dot" />
          <div className="save-version-card">
            <div className="save-version-head">
              <div>
                <strong>{new Date(version.createdAt).toLocaleString()}</strong>
                <span className="muted"> · {version.deviceId ?? 'This device'}</span>
              </div>
              <span className="badge">{index === 0 ? 'Latest' : `v${versions.length - index}`}</span>
            </div>
            <div className="save-version-meta">
              <span>{version.fileCount} files</span>
              <span>{(version.sizeBytes / 1024 / 1024).toFixed(1)} MB</span>
              <span className={`status-pill status-${version.status}`}>{version.status}</span>
            </div>
            {version.changeSummary && <p className="save-version-summary">{version.changeSummary}</p>}
            <div className="save-version-actions">
              <button className="btn btn-secondary btn-sm" onClick={() => onRestore?.(version.id)}>
                Restore
              </button>
            </div>
          </div>
        </li>
      ))}
    </ol>
  );
}
