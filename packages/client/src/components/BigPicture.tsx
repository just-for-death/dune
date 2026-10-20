import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { Game } from '@dune/shared';

interface Props {
  games: Game[];
  onLaunch?: (game: Game) => void;
}

type Direction = 'left' | 'right' | 'up' | 'down';

const KEY_DIRECTIONS: Record<string, Direction> = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down',
};

// Standard Gamepad mapping: 0 = A (south), 12-15 = d-pad up/down/left/right.
const PAD_A = 0;
const PAD_DPAD: [number, Direction][] = [[12, 'up'], [13, 'down'], [14, 'left'], [15, 'right']];
const STICK_THRESHOLD = 0.5;
const REPEAT_DELAY_MS = 380;
const REPEAT_INTERVAL_MS = 140;

function readPadDirection(pad: Gamepad): Direction | null {
  for (const [button, direction] of PAD_DPAD) {
    if (pad.buttons[button]?.pressed) return direction;
  }
  const x = pad.axes[0] ?? 0;
  const y = pad.axes[1] ?? 0;
  if (Math.max(Math.abs(x), Math.abs(y)) < STICK_THRESHOLD) return null;
  if (Math.abs(x) >= Math.abs(y)) return x > 0 ? 'right' : 'left';
  return y > 0 ? 'down' : 'up';
}

export function BigPicture({ games, onLaunch }: Props) {
  const gridRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef(0);
  const [activeIndex, setActiveIndex] = useState(0);
  const count = games.length;
  const rovingIndex = Math.min(activeIndex, Math.max(0, count - 1));
  const hasGames = count > 0;

  const cards = useCallback(
    () => Array.from(gridRef.current?.querySelectorAll<HTMLButtonElement>('.big-picture-card') ?? []),
    [],
  );

  const focusIndex = useCallback((index: number) => {
    const list = cards();
    if (list.length === 0) return;
    const next = Math.max(0, Math.min(index, list.length - 1));
    activeRef.current = next;
    setActiveIndex(next);
    list[next].focus();
  }, [cards]);

  const move = useCallback((direction: Direction) => {
    const list = cards();
    const grid = gridRef.current;
    if (!grid || list.length === 0) return;
    const focusedIndex = list.indexOf(document.activeElement as HTMLButtonElement);
    // First input while focus is elsewhere just brings focus into the grid.
    if (focusedIndex === -1) {
      focusIndex(Math.min(activeRef.current, list.length - 1));
      return;
    }
    const columns = Math.max(1, getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length);
    const offsets: Record<Direction, number> = { left: -1, right: 1, up: -columns, down: columns };
    const target = focusedIndex + offsets[direction];
    if (target < 0 || target >= list.length) return;
    focusIndex(target);
  }, [cards, focusIndex]);

  const activate = useCallback(() => {
    const list = cards();
    const focusedIndex = list.indexOf(document.activeElement as HTMLButtonElement);
    if (focusedIndex === -1) focusIndex(activeRef.current);
    else list[focusedIndex].click();
  }, [cards, focusIndex]);

  // Land keyboard/controller users on the first card when the view opens.
  // The card's onFocus handler syncs the roving index.
  useEffect(() => {
    if (hasGames) cards()[0]?.focus();
  }, [hasGames, cards]);

  // Gamepad polling: one rAF loop that only runs while the window has focus.
  useEffect(() => {
    if (typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') return;
    let frame = 0;
    let heldDirection: Direction | null = null;
    let nextRepeatAt = 0;
    let aWasPressed = false;

    const poll = (now: number) => {
      frame = requestAnimationFrame(poll);
      let direction: Direction | null = null;
      let aPressed = false;
      for (const pad of navigator.getGamepads()) {
        if (!pad) continue;
        direction = direction ?? readPadDirection(pad);
        aPressed = aPressed || Boolean(pad.buttons[PAD_A]?.pressed);
      }
      if (direction !== heldDirection) {
        heldDirection = direction;
        if (direction) {
          move(direction);
          nextRepeatAt = now + REPEAT_DELAY_MS;
        }
      } else if (direction && now >= nextRepeatAt) {
        move(direction);
        nextRepeatAt = now + REPEAT_INTERVAL_MS;
      }
      if (aPressed && !aWasPressed) activate();
      aWasPressed = aPressed;
    };

    const start = () => {
      if (frame === 0) frame = requestAnimationFrame(poll);
    };
    const stop = () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      frame = 0;
      heldDirection = null;
      aWasPressed = false;
    };

    if (document.hasFocus()) start();
    window.addEventListener('focus', start);
    window.addEventListener('blur', stop);
    return () => {
      stop();
      window.removeEventListener('focus', start);
      window.removeEventListener('blur', stop);
    };
  }, [move, activate]);

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const direction = KEY_DIRECTIONS[event.key];
    if (direction) {
      event.preventDefault();
      move(direction);
    } else if (event.key === 'Home') {
      event.preventDefault();
      focusIndex(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      focusIndex(count - 1);
    }
    // Enter / Space activate the focused <button> natively.
  };

  return (
    <div className="big-picture">
      <div className="big-picture-header">
        <h2>Dune Big Picture</h2>
        <p className="muted">Controller-friendly library view. Use arrow keys or a gamepad to move, Enter or A to launch.</p>
      </div>
      {hasGames ? (
        <div ref={gridRef} className="big-picture-grid" role="group" aria-label="Game library" onKeyDown={handleKeyDown}>
          {games.map((game, index) => (
            <button
              key={game.id}
              type="button"
              className="big-picture-card"
              tabIndex={index === rovingIndex ? 0 : -1}
              onFocus={() => {
                activeRef.current = index;
                setActiveIndex(index);
              }}
              onClick={() => onLaunch?.(game)}
            >
              {game.thumbnail ? (
                <img className="big-picture-cover" src={game.thumbnail} alt="" loading="lazy" />
              ) : (
                <span className="big-picture-cover" aria-hidden="true" />
              )}
              <span className="big-picture-title" title={game.name}>{game.name}</span>
              <span className="big-picture-meta">{game.status}</span>
            </button>
          ))}
        </div>
      ) : (
        <div className="empty-state">
          <p>No games in your library yet.</p>
          <p className="muted">Add games in Game Paths and they will show up here.</p>
        </div>
      )}
    </div>
  );
}
