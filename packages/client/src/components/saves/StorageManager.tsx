import type { StorageEntry } from '@dune/shared';
import { useI18n } from '../../i18n/context';
import { formatBytes } from '../../services/format';

interface Drive {
  name: string;
  totalBytes: number;
  freeBytes: number;
}

interface Props {
  drives: Drive[];
  entries: StorageEntry[];
  /** Library name for a game id; unknown ids fall back to "Game #id". */
  gameName?: (gameId: number) => string | undefined;
}

export function StorageManager({ drives, entries, gameName }: Props) {
  const { locale, t } = useI18n();
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
                <span className="muted">{t('storage.free', { size: formatBytes(drive.freeBytes) })}</span>
              </div>
              <div className="storage-bar">
                <div className="storage-bar-fill" style={{ width: `${Math.min(100, percent)}%` }} />
              </div>
              <div className="storage-drive-meta">
                <span>{t('storage.used', { size: formatBytes(used) })}</span>
                <span>{t('storage.total', { size: formatBytes(drive.totalBytes) })}</span>
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
              <td>{gameName?.(entry.gameId) ?? t('storage.gameId', { id: entry.gameId })}</td>
              <td>{formatBytes(entry.saveBytes)}</td>
              <td>{formatBytes(entry.cacheBytes)}</td>
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
