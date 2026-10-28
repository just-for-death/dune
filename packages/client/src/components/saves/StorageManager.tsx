import type { StorageEntry } from '@dune/shared';
import { useI18n } from '../../i18n/context';

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
  const { locale, t } = useI18n();
  const gb = (bytes: number, digits: number) => (bytes / 1024 / 1024 / 1024).toFixed(digits);
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
                <span className="muted">{t('storage.freeGb', { size: gb(drive.freeBytes, 1) })}</span>
              </div>
              <div className="storage-bar">
                <div className="storage-bar-fill" style={{ width: `${Math.min(100, percent)}%` }} />
              </div>
              <div className="storage-drive-meta">
                <span>{t('storage.usedGb', { size: gb(used, 1) })}</span>
                <span>{t('storage.totalGb', { size: gb(drive.totalBytes, 0) })}</span>
              </div>
            </div>
          );
        })}
      </div>

      <div className="table-wrapper">
      <table className="data-table">
        <thead>
          <tr>
            <th>{t('table.game')}</th>
            <th>{t('storage.saveSize')}</th>
            <th>{t('storage.cacheSize')}</th>
            <th>{t('storage.lastPlayed')}</th>
            <th>{t('storage.drive')}</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <tr key={entry.gameId}>
              <td>{t('storage.gameId', { id: entry.gameId })}</td>
              <td>{(entry.saveBytes / 1024 / 1024).toFixed(1)} MB</td>
              <td>{(entry.cacheBytes / 1024 / 1024).toFixed(1)} MB</td>
              <td>{entry.lastPlayed ? new Date(entry.lastPlayed).toLocaleDateString(locale) : t('common.never')}</td>
              <td>{entry.drive}</td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </div>
  );
}
