import type { Game } from '@dune/shared';
import { installPathOf, savePathOf, sourceInfo } from '../services/gameInfo';

/** Coloured, AA-contrast badge for where a game was found. Renders nothing without a source. */
export function SourceBadge({ game }: { game: Pick<Game, 'source'> }) {
  const info = sourceInfo(game);
  if (!info) return null;
  return (
    <span className={`badge source-badge source-${info.kind}`} title={info.detail}>
      <span className="sr-only">Source: </span>
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
  const savePath = savePathOf(game);
  const installPath = installPathOf(game);
  return (
    <dl className={`path-info${compact ? ' path-info-compact' : ''}`}>
      <div className="path-info-row">
        <dt>Save path</dt>
        <dd>
          {savePath ? (
            <code className="path-value" title={savePath}>{savePath}</code>
          ) : (
            <span className="path-missing">No save folder found</span>
          )}
        </dd>
      </div>
      {installPath && (
        <div className="path-info-row">
          <dt>Install folder</dt>
          <dd>
            <code className="path-value" title={installPath}>{installPath}</code>
          </dd>
        </div>
      )}
    </dl>
  );
}
