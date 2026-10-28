import { useI18n } from '../i18n/context';

interface Props {
  /** Full translated sentence, e.g. t('noServer.playtime'). */
  message: string;
  onOpenSettings: () => void;
}

/** DUN-041: calm, non-error notice for views that need a Dune server. */
export function NoServerNotice({ message, onOpenSettings }: Props) {
  const { t } = useI18n();
  return (
    <div className="card no-server-card">
      <p className="no-server-text">
        {message}
      </p>
      <button type="button" className="btn btn-secondary btn-sm" onClick={onOpenSettings}>{t('noServer.setUp')}</button>
    </div>
  );
}
