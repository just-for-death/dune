import type { DriveRow } from '../../services/driveSpace';
import { useI18n } from '../../i18n/context';

interface Props {
  rows: DriveRow[] | null;
  error: boolean;
  onRetry: () => void;
}

/** DUN-042: free space per drive from getDiskSpace(); unavailable drives say why in plain words. */
export function DriveSpaceList({ rows, error, onRetry }: Props) {
  const { t } = useI18n();
  if (error) {
    return (
      <div className="inline-error" role="alert">
        <span>{t('drives.unavailable')}</span>
        <button type="button" className="btn btn-secondary btn-sm" onClick={onRetry}>{t('common.tryAgain')}</button>
      </div>
    );
  }
  if (rows === null) return <p className="text-muted text-sm" role="status">{t('drives.reading')}</p>;
  if (rows.length === 0) return <p className="text-muted text-sm">{t('drives.empty')}</p>;
  return (
    <ul className="drive-list" aria-label={t('drives.label')}>
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
                aria-label={t('drives.usedLabel', { title: row.title })}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={row.usedPercent}
                aria-valuetext={t('drives.usedValue', { percent: row.usedPercent, free: row.freeText })}
              >
                <div className="storage-bar-fill" style={{ width: `${row.usedPercent}%` }} />
              </div>
              <div className="storage-drive-meta">
                <span>{t('drives.used', { percent: row.usedPercent })}</span>
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
