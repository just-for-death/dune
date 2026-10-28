import type { Game } from '@dune/shared';
import { installPathOf, savePathOf, sourceInfo } from '../services/gameInfo';
import { useI18n } from '../i18n/context';

/** Coloured, AA-contrast badge for where a game was found. Renders nothing without a source. */
export function SourceBadge({ game }: { game: Pick<Game, 'source'> }) {
  const { t } = useI18n();
  const info = sourceInfo(game, t);
  if (!info) return null;
  return (
    <span className={`badge source-badge source-${info.kind}`} title={info.detail}>
      <span className="sr-only">{t('source.prefix')}</span>
      {info.label}
    </span>
  );
}

/**
 * Save folder (always shown; "No save folder found" when empty) and install
 * folder (only when known). Paths wrap, keep a full-text title, and are
 * selectable so they can be copied.
 */
export function GamePathInfo({ game, compact = false }: { game: Pick<Game, 'linPath' | 'winPath' | 'installPath'>; compact?: boolean }) {
  const { t } = useI18n();
  const savePath = savePathOf(game);
  const installPath = installPathOf(game);
  return (
    <dl className={`path-info${compact ? ' path-info-compact' : ''}`}>
      <div className="path-info-row">
        <dt>{t('paths.save')}</dt>
        <dd>
          {savePath ? (
            <code className="path-value" title={savePath}>{savePath}</code>
          ) : (
            <span className="path-missing">{t('paths.noSave')}</span>
          )}
        </dd>
      </div>
      {installPath && (
        <div className="path-info-row">
          <dt>{t('paths.install')}</dt>
          <dd>
            <code className="path-value" title={installPath}>{installPath}</code>
          </dd>
        </div>
      )}
    </dl>
  );
}
