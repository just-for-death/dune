import type { SaveVersion } from '@dune/shared';
import { useI18n } from '../../i18n/context';
import type { MessageKey } from '../../i18n';

const STATUS_KEYS: Record<SaveVersion['status'], MessageKey> = {
  complete: 'saves.status.complete',
  partial: 'saves.status.partial',
  restored: 'saves.status.restored',
};

interface Props {
  versions: SaveVersion[];
  onRestore?: (versionId: string) => void;
}

export function SaveVersionTimeline({ versions, onRestore }: Props) {
  const { locale, t, tc } = useI18n();
  if (versions.length === 0) {
    return (
      <div className="empty-state">
        <p>{t('saves.noVersions')}</p>
        <p className="muted">{t('saves.noVersionsHint')}</p>
      </div>
    );
  }

  return (
    <ol className="save-timeline">
      {versions.map((version, index) => {
        const created = new Date(version.createdAt).toLocaleString(locale);
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
              <span>{(version.sizeBytes / 1024 / 1024).toFixed(1)} MB</span>
              <span className={`status-pill status-${version.status}`}>{STATUS_KEYS[version.status] ? t(STATUS_KEYS[version.status]) : version.status}</span>
            </div>
            {version.changeSummary && <p className="save-version-summary">{version.changeSummary}</p>}
            <div className="save-version-actions">
              <button className="btn btn-secondary btn-sm" aria-label={t('saves.restoreLabel', { date: created })} onClick={() => onRestore?.(version.id)}>
                {t('saves.restore')}
              </button>
            </div>
          </div>
        </li>
        );
      })}
    </ol>
  );
}
