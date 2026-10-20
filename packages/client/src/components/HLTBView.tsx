import type { Game, HLTBTimes } from '@dune/shared';

interface Props {
  games: Game[];
  cache: Record<string, HLTBTimes>;
  loading: Record<string, boolean>;
  onLoad: (gameName: string) => void;
}

export function HLTBView({ games, cache, loading, onLoad }: Props) {
  return (
    <div>
      <div className="section-header">
        <h2>HowLongToBeat</h2>
        <p className="text-muted">Estimated completion times for tracked games.</p>
      </div>
      <div className="card">
        <table className="data-table">
          <thead>
            <tr>
              <th>Game</th>
              <th>Main Story</th>
              <th>Main + Extra</th>
              <th>Completionist</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {games.map((game) => {
              const times = cache[game.name];
              return (
                <tr key={game.id}>
                  <td>{game.name}</td>
                  <td>{times ? `${Math.round(times.mainStory / 60)}h` : '—'}</td>
                  <td>{times ? `${Math.round(times.mainExtra / 60)}h` : '—'}</td>
                  <td>{times ? `${Math.round(times.completionist / 60)}h` : '—'}</td>
                  <td>
                    {times ? (times.fetchedAt ? 'Cached' : 'Loaded') : (
                      <button className="btn btn-secondary btn-sm" onClick={() => onLoad(game.name)} disabled={loading[game.name]}>
                        {loading[game.name] ? 'Loading...' : 'Load'}
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
  );
}
