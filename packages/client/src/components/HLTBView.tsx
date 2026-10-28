import type { Game, HLTBTimes } from '@dune/shared';
import { useI18n } from '../i18n/context';

interface Props {
  games: Game[];
  cache: Record<string, HLTBTimes>;
  loading: Record<string, boolean>;
  onLoad: (gameName: string) => void;
}

export function HLTBView({ games, cache, loading, onLoad }: Props) {
  const { t } = useI18n();
  const hours = (minutes: number) => t('hltb.hours', { hours: Math.round(minutes / 60) });
  return (
    <div>
      <div className="section-header">
        <h2>{t('hltb.title')}</h2>
        <p className="text-muted">{t('hltb.subtitle')}</p>
      </div>
      <div className="card">
        <div className="table-wrapper">
        <table className="data-table">
          <thead>
            <tr>
              <th>{t('table.game')}</th>
              <th>{t('hltb.mainStory')}</th>
              <th>{t('hltb.mainExtra')}</th>
              <th>{t('hltb.completionist')}</th>
              <th>{t('table.status')}</th>
            </tr>
          </thead>
          <tbody>
            {games.map((game) => {
              const times = cache[game.name];
              return (
                <tr key={game.id}>
                  <td>{game.name}</td>
                  <td>{times ? hours(times.mainStory) : <><span aria-hidden="true">—</span><span className="sr-only">{t('common.none')}</span></>}</td>
                  <td>{times ? hours(times.mainExtra) : <><span aria-hidden="true">—</span><span className="sr-only">{t('common.none')}</span></>}</td>
                  <td>{times ? hours(times.completionist) : <><span aria-hidden="true">—</span><span className="sr-only">{t('common.none')}</span></>}</td>
                  <td>
                    {times ? (times.fetchedAt ? t('hltb.cached') : t('hltb.loaded')) : (
                      <button className="btn btn-secondary btn-sm" aria-label={t('hltb.loadLabel', { game: game.name })} onClick={() => onLoad(game.name)} disabled={loading[game.name]}>
                        {loading[game.name] ? t('common.loadingDots') : t('hltb.load')}
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        </div>
      </div>
    </div>
  );
}
