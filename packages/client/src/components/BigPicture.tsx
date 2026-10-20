import type { Game } from '@dune/shared';

interface Props {
  games: Game[];
  onLaunch?: (game: Game) => void;
}

export function BigPicture({ games, onLaunch }: Props) {
  return (
    <div className="big-picture">
      <div className="big-picture-header">
        <h1>Dune Big Picture</h1>
        <p className="muted">Controller-friendly library view</p>
      </div>
      <div className="big-picture-grid">
        {games.map((game) => (
          <button key={game.id} className="big-picture-card" onClick={() => onLaunch?.(game)}>
            <div className="big-picture-cover" />
            <div className="big-picture-title">{game.name}</div>
            <div className="big-picture-meta">{game.status}</div>
          </button>
        ))}
      </div>
    </div>
  );
}
