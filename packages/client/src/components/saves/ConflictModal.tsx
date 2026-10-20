import type { ConflictRecord, SaveVersion } from '@dune/shared';

interface Props {
  conflict: ConflictRecord | null;
  localVersion?: SaveVersion;
  remoteVersion?: SaveVersion;
  open: boolean;
  onClose: () => void;
  onResolve: (resolution: 'local' | 'remote' | 'both' | 'later') => void;
}

export function ConflictModal({ conflict, localVersion, remoteVersion, open, onClose, onResolve }: Props) {
  if (!open || !conflict) return null;

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal-card conflict-modal">
        <h3>Save conflict detected</h3>
        <p className="muted">Two devices changed this game. Choose which copy to keep. Nothing is overwritten silently.</p>

        <div className="conflict-grid">
          <div className="conflict-option">
            <h4>On this machine</h4>
            <div className="conflict-meta">{localVersion ? new Date(localVersion.createdAt).toLocaleString() : 'Unknown'}</div>
            <div className="conflict-meta">{localVersion ? `${localVersion.fileCount} files · ${(localVersion.sizeBytes / 1024 / 1024).toFixed(1)} MB` : '—'}</div>
            <button className="btn btn-primary" onClick={() => onResolve('local')}>Keep this one</button>
          </div>
          <div className="conflict-option">
            <h4>In the cloud</h4>
            <div className="conflict-meta">{remoteVersion ? new Date(remoteVersion.createdAt).toLocaleString() : 'Unknown'}</div>
            <div className="conflict-meta">{remoteVersion ? `${remoteVersion.fileCount} files · ${(remoteVersion.sizeBytes / 1024 / 1024).toFixed(1)} MB` : '—'}</div>
            <button className="btn btn-primary" onClick={() => onResolve('remote')}>Keep this one</button>
          </div>
        </div>

        <div className="conflict-actions">
          <button className="btn btn-secondary" onClick={() => onResolve('both')}>Keep both</button>
          <button className="btn btn-secondary" onClick={() => onResolve('later')}>Decide later</button>
          <button className="btn btn-secondary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
