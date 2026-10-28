import { useCallback, useState } from 'react';
import { Icon } from '../../Icon';
import { useI18n } from '../../i18n/context';
import { DownloadsQueue } from './DownloadsQueue';
import { DownloadsSettingsPanel } from './DownloadsSettingsPanel';
import { hasDownloadsApi, type DownloadSettings, type DownloadsViewApi } from './types';

export interface DownloadsViewProps {
  /** window.electronAPI; undefined or without the downloads methods in a web/dev build. */
  api: Partial<DownloadsViewApi> | undefined;
}

/** The Downloads tab: settings + queue, or an unavailable note when the bridge has no downloads IPC. */
export function DownloadsView({ api }: DownloadsViewProps) {
  const { t } = useI18n();
  const [downloadsBaseDir, setDownloadsBaseDir] = useState<string | undefined>(undefined);
  const onSettings = useCallback((s: DownloadSettings) => setDownloadsBaseDir(s.baseDir), []);
  return (
    <div>
      <div className="section-header">
        <h2>{t('downloads.title')}</h2>
        <p className="text-muted">{t('downloads.subtitle')}</p>
      </div>
      {hasDownloadsApi(api) ? (
        <>
          <DownloadsSettingsPanel api={api} onSettings={onSettings} />
          <DownloadsQueue api={api} baseDir={downloadsBaseDir} />
        </>
      ) : (
        <div className="card">
          <div className="empty-state" role="status">
            <Icon name="export" size={28} />
            <p>{t('downloads.unavailable')}</p>
          </div>
        </div>
      )}
    </div>
  );
}
