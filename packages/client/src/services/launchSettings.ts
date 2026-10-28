/**
 * DUN-061 part 2: renderer view of a game's launch setup. Launch fields are
 * main-only; the renderer only reads them to show status and sends ids.
 */
import type { Game } from '@dune/shared';
import { defaultTranslator, type MessageKey, type Translator } from '../i18n';

export type Readiness =
  | { ready: true; via: 'steam' | 'heroic' | 'lutris' | 'emulator' | 'executable'; label: string }
  | { ready: false; needs: 'executable' | 'emulator' };

export function launchReadiness(
  game: Pick<Game, 'source' | 'steamAppId' | 'heroicId' | 'lutrisSlug' | 'executable' | 'emulator'>,
  t: Translator = defaultTranslator,
): Readiness {
  if (game.source === 'steam' && game.steamAppId) return { ready: true, via: 'steam', label: t('launch.viaSteam') };
  if (game.source === 'heroic' && game.heroicId) return { ready: true, via: 'heroic', label: t('launch.viaHeroic') };
  if (game.source === 'lutris' && game.lutrisSlug) return { ready: true, via: 'lutris', label: t('launch.viaLutris') };
  if (game.source === 'emulator') {
    return game.emulator ? { ready: true, via: 'emulator', label: t('launch.viaEmulator') } : { ready: false, needs: 'emulator' };
  }
  if (game.executable?.trim()) return { ready: true, via: 'executable', label: t('launch.viaExecutable', { file: fileName(game.executable) }) };
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

const PICK: Record<string, MessageKey> = {
  'not-found': 'launch.gameGone',
  invalid: 'launch.pick.invalid',
  error: 'launch.pick.error',
};
const PREFIX: Record<string, MessageKey> = {
  'not-found': 'launch.gameGone',
  'prefix-not-found': 'launch.prefix.notFound',
  error: 'launch.prefix.error',
};
const EMULATOR: Record<string, MessageKey> = {
  'not-found': 'launch.gameGone',
  'unknown-emulator': 'launch.emulator.unknown',
  'not-emulator': 'launch.emulator.notEmulator',
  error: 'launch.emulator.error',
};

const lookup = (table: Record<string, MessageKey>, reason: string | undefined, t: Translator) =>
  t(reason && Object.prototype.hasOwnProperty.call(table, reason) ? table[reason] : table.error);

/** null for 'cancelled': the user closed the dialog, nothing to report. */
export function pickFailureMessage(reason: string | undefined, t: Translator = defaultTranslator): string | null {
  return reason === 'cancelled' ? null : lookup(PICK, reason, t);
}
export const prefixSetFailureMessage = (reason: string | undefined, t: Translator = defaultTranslator) => lookup(PREFIX, reason, t);
export const emulatorSetFailureMessage = (reason: string | undefined, t: Translator = defaultTranslator) => lookup(EMULATOR, reason, t);
