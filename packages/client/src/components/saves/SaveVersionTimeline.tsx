import type { SaveVersion } from '@dune/shared';
import { useI18n } from '../../i18n/context';
import type { MessageKey } from '../../i18n';
import { formatBytes, formatDate } from '../../services/format';

const STATUS_KEYS: Record<SaveVersion['status'], MessageKey> = {
  complete: 'saves.status.complete',
  partial: 'saves.status.partial',
  restored: 'saves.status.restored',
};

interface Props {
  versions: SaveVersion[];
  onRestore?: (version: SaveVersion) => void;
  /** DUN-018: version being restored; every Restore button is unavailable meanwhile. */
  restoringId?: string | null;
}

export function SaveVersionTimeline({ versions, onRestore, restoringId = null }: Props) {
  const { locale, t, tc } = useI18n();
  const busy = restoringId !== null;
  if (versions.length === 0) {
    return (
      <div className="empty-state">
        <p>{t('saves.noVersions')}</p>
        <p className="muted">{t('saves.noVersionsHint')}</p>
      </div>
    );
  }

  return (
    <ol className="save-timeline" aria-busy={busy || undefined}>
      {versions.map((version, index) => {
        const created = formatDate(version.createdAt, locale, t);
        const restoring = version.id === restoringId;
        return (
        <li key={version.id} className={`save-version ${index === 0 ? 'save-version-latest' : ''}`}>
          <div className="save-version-dot" />
          <div className="save-version-card">
            <div className="save-version-head">
              <div>
                <strong>{created}</strong>
                <span className="muted"> · {version.deviceId ?? t('saves.thisDevice')}</span>
              </div>
              <span className="badge">{index === 0 ? t('saves.latest') : `v${versions.length - index}`}</span>
            </div>
            <div className="save-version-meta">
              <span>{tc('saves.files', version.fileCount)}</span>
              <span>{formatBytes(version.sizeBytes)}</span>
              <span className={`status-pill status-${version.status}`}>{STATUS_KEYS[version.status] ? t(STATUS_KEYS[version.status]) : version.status}</span>
            </div>
            {version.changeSummary && <p className="save-version-summary">{version.changeSummary}</p>}
            <div className="save-version-actions">
              {/* aria-disabled (not disabled) keeps focus here when the confirm dialog closes. */}
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                aria-label={t(restoring ? 'saves.restoringLabel' : 'saves.restoreLabel', { date: created })}
                aria-disabled={busy || undefined}
                onClick={() => { if (!busy) onRestore?.(version); }}
              >
                {restoring ? t('saves.restoring') : t('saves.restore')}
              </button>
            </div>
          </div>
        </li>
        );
      })}
    </ol>
  );
}
