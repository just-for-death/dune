import { useId, useState } from 'react';
import type { EmulatorInfo, Game, ManagedPrefix } from '@dune/shared';
import {
  emulatorSetFailureMessage, launchReadiness, pickFailureMessage, prefixSetFailureMessage, usesEmulator, usesWinePrefix,
} from '../services/launchSettings';
import { useI18n } from '../i18n/context';

interface Props {
  game: Game;
  /** null while loading. */
  prefixes: ManagedPrefix[] | null;
  emulators: EmulatorInfo[] | null;
  onUpdated: (game: Game) => void;
}

/**
 * DUN-061 part 2: launch status plus the only launch controls the renderer
 * has. The executable is chosen in main's own file dialog; prefix and emulator
 * are sent as ids. Paths, args, env and cwd are never sent from here.
 */
export function LaunchSettings({ game, prefixes, emulators, onUpdated }: Props) {
  const [busy, setBusy] = useState<'pick' | 'prefix' | 'emulator' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ids = { status: useId(), prefix: useId(), emulator: useId(), error: useId() };
  const { t } = useI18n();
  const readiness = launchReadiness(game, t);

  const run = async <R extends { ok: boolean; reason?: string; game?: Game }>(
    kind: 'pick' | 'prefix' | 'emulator',
    call: () => Promise<R>,
    message: (reason: string | undefined, translate: typeof t) => string | null,
  ) => {
    if (busy) return;
    setBusy(kind);
    setError(null);
    try {
      const res = await call();
      if (res.ok && res.game) onUpdated(res.game);
      else if (!res.ok) setError(message(res.reason, t));
    } catch {
      setError(message('error', t));
    }
    setBusy(null);
  };

  const pick = () => run('pick', () => window.electronAPI.pickLaunchTarget(game.id), pickFailureMessage);

  return (
    <div className="launch-settings">
      <p id={ids.status} className={readiness.ready ? 'launch-status' : 'launch-status launch-status-missing'}>
        {readiness.ready ? readiness.label : readiness.needs === 'emulator' ? t('launch.notReadyEmulator') : t('launch.notReady')}
      </p>
      <div className="launch-controls">
        {!usesEmulator(game) && (
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            aria-describedby={ids.status}
            aria-disabled={busy === 'pick' || undefined}
            onClick={pick}
          >
            {readiness.ready && readiness.via === 'executable' ? t('launch.changeExe') : t('launch.chooseExe')}
          </button>
        )}
        {usesWinePrefix(game) && (
          <div className="launch-field">
            <label htmlFor={ids.prefix}>{t('launch.winePrefix')}</label>
            <select
              id={ids.prefix}
              value={game.managedPrefixId ?? ''}
              disabled={prefixes === null || busy === 'prefix'}
              aria-describedby={error ? ids.error : undefined}
              onChange={e => run('prefix', () => window.electronAPI.setGamePrefix(game.id, e.target.value || null), prefixSetFailureMessage)}
            >
              <option value="">{t('common.none')}</option>
              {(prefixes ?? []).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              {game.managedPrefixId && prefixes && !prefixes.some(p => p.id === game.managedPrefixId) && (
                <option value={game.managedPrefixId}>{t('launch.missingPrefix')}</option>
              )}
            </select>
          </div>
        )}
        {usesEmulator(game) && (
          <div className="launch-field">
            <label htmlFor={ids.emulator}>{t('launch.emulator')}</label>
            <select
              id={ids.emulator}
              value={game.emulator ?? ''}
              disabled={emulators === null || busy === 'emulator'}
              aria-describedby={error ? ids.error : undefined}
              onChange={e => run('emulator', () => window.electronAPI.setGameEmulator(game.id, e.target.value || null), emulatorSetFailureMessage)}
            >
              <option value="">{t('common.none')}</option>
              {(emulators ?? []).map(em => <option key={em.id} value={em.id}>{em.name}</option>)}
              {game.emulator && emulators && !emulators.some(em => em.id === game.emulator) && (
                <option value={game.emulator}>{game.emulator}</option>
              )}
            </select>
          </div>
        )}
      </div>
      {error && <p id={ids.error} className="error-text" role="alert">{error}</p>}
    </div>
  );
}
