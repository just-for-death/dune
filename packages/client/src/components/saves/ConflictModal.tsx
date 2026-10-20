import { useEffect, useId, useRef } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, SyntheticEvent } from 'react';
import type { ConflictRecord, SaveVersion } from '@dune/shared';

type Resolution = 'local' | 'remote' | 'both' | 'later';

interface Props {
  conflict: ConflictRecord | null;
  localVersion?: SaveVersion;
  remoteVersion?: SaveVersion;
  open: boolean;
  onClose: () => void;
  onResolve: (resolution: Resolution) => void;
}

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function VersionDetails({ version }: { version?: SaveVersion }) {
  // SaveVersion only carries an opaque deviceId (no human-readable device
  // name), so no device line is shown here until the data provides one.
  return (
    <>
      <div className="conflict-meta">{version ? new Date(version.createdAt).toLocaleString() : 'Unknown'}</div>
      <div className="conflict-meta">
        {version ? `${version.fileCount} file${version.fileCount === 1 ? '' : 's'} · ${formatBytes(version.sizeBytes)}` : '—'}
      </div>
    </>
  );
}

/**
 * Save-conflict picker rendered in a native modal <dialog> (showModal), so
 * the rest of the app is inert while it is open. Escape maps to
 * "Decide later"; focus moves to the first action on open and returns to the
 * previously focused element on close.
 */
export function ConflictModal({ conflict, localVersion, remoteVersion, open, onClose, onResolve }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const firstActionRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const descId = useId();
  const isOpen = open && conflict !== null;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!isOpen || !dialog) return;
    const returnFocusTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!dialog.open) {
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
    }
    firstActionRef.current?.focus();
    return () => {
      if (dialog.open) dialog.close();
      if (returnFocusTo?.isConnected) returnFocusTo.focus();
    };
  }, [isOpen]);

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDialogElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onResolve('later');
      return;
    }
    if (event.key !== 'Tab') return;
    // showModal() already makes the page inert; this keeps Tab cycling inside
    // the dialog instead of escaping to the browser chrome.
    const focusables = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const handleCancel = (event: SyntheticEvent<HTMLDialogElement>) => {
    // Fallback for a native cancel request that bypassed keydown.
    event.preventDefault();
    onResolve('later');
  };

  const handleNativeClose = () => {
    // The browser closed the dialog on its own (e.g. a forced cancel); keep
    // React state in sync.
    if (isOpen) onClose();
  };

  return (
    <dialog
      ref={dialogRef}
      className="modal-card conflict-modal"
      aria-labelledby={titleId}
      aria-describedby={descId}
      onKeyDown={handleKeyDown}
      onCancel={handleCancel}
      onClose={handleNativeClose}
    >
      {isOpen && (
        <>
          <h3 id={titleId} className="conflict-title">Save conflict detected</h3>
          <p id={descId} className="muted">Two devices changed this game. Choose which copy to keep. Nothing is overwritten silently.</p>

          <div className="conflict-grid">
            <div className="conflict-option">
              <h4>On this machine</h4>
              <VersionDetails version={localVersion} />
              <button ref={firstActionRef} className="btn btn-primary" onClick={() => onResolve('local')}>Keep local copy</button>
            </div>
            <div className="conflict-option">
              <h4>On the server</h4>
              <VersionDetails version={remoteVersion} />
              <button className="btn btn-primary" onClick={() => onResolve('remote')}>Keep server copy</button>
            </div>
          </div>

          <div className="conflict-actions">
            <button className="btn btn-secondary" onClick={() => onResolve('both')}>Keep both</button>
            <button className="btn btn-secondary" onClick={() => onResolve('later')}>Decide later</button>
            <button className="btn btn-secondary" onClick={onClose}>Close</button>
          </div>
        </>
      )}
    </dialog>
  );
}
