/**
 * DUN-061 part 2: renderer view of a game's launch setup. Launch fields are
 * main-only; the renderer only reads them to show status and sends ids.
 */
import type { Game } from '@dune/shared';

export type Readiness =
  | { ready: true; via: 'steam' | 'heroic' | 'lutris' | 'emulator' | 'executable'; label: string }
  | { ready: false; needs: 'executable' | 'emulator' };

export function launchReadiness(game: Pick<Game, 'source' | 'steamAppId' | 'heroicId' | 'lutrisSlug' | 'executable' | 'emulator'>): Readiness {
  if (game.source === 'steam' && game.steamAppId) return { ready: true, via: 'steam', label: 'Starts through Steam' };
  if (game.source === 'heroic' && game.heroicId) return { ready: true, via: 'heroic', label: 'Starts through Heroic' };
  if (game.source === 'lutris' && game.lutrisSlug) return { ready: true, via: 'lutris', label: 'Starts through Lutris' };
  if (game.source === 'emulator') {
    return game.emulator ? { ready: true, via: 'emulator', label: 'Starts in the chosen emulator' } : { ready: false, needs: 'emulator' };
  }
  if (game.executable?.trim()) return { ready: true, via: 'executable', label: `Starts ${fileName(game.executable)}` };
  return { ready: false, needs: 'executable' };
}

export function fileName(path: string): string {
  const parts = path.trim().split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : path.trim();
}

/** Launchers manage their own runtime; only other games get a Wine prefix picker. */
export function usesWinePrefix(game: Pick<Game, 'source'>): boolean {
  return !['steam', 'heroic', 'lutris', 'emulator'].includes(game.source ?? '');
}

export function usesEmulator(game: Pick<Game, 'source'>): boolean {
  return game.source === 'emulator';
}

const PICK: Record<string, string> = {
  'not-found': 'This game is no longer in your library. Refresh and try again.',
  invalid: 'That file can’t be launched. Choose the game’s program file.',
  error: 'Could not save the executable. Try again.',
};
const PREFIX: Record<string, string> = {
  'not-found': 'This game is no longer in your library. Refresh and try again.',
  'prefix-not-found': 'That prefix no longer exists. Pick another one.',
  error: 'Could not save the prefix. Try again.',
};
const EMULATOR: Record<string, string> = {
  'not-found': 'This game is no longer in your library. Refresh and try again.',
  'unknown-emulator': 'That emulator isn’t available any more. Pick another one.',
  'not-emulator': 'Only emulator games can use an emulator.',
  error: 'Could not save the emulator. Try again.',
};

const lookup = (table: Record<string, string>, reason: string | undefined) =>
  reason && Object.prototype.hasOwnProperty.call(table, reason) ? table[reason] : table.error;

/** null for 'cancelled': the user closed the dialog, nothing to report. */
export function pickFailureMessage(reason: string | undefined): string | null {
  return reason === 'cancelled' ? null : lookup(PICK, reason);
}
export const prefixSetFailureMessage = (reason: string | undefined) => lookup(PREFIX, reason);
export const emulatorSetFailureMessage = (reason: string | undefined) => lookup(EMULATOR, reason);
