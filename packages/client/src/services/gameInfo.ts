import type { Game } from '@dune/shared';
import { defaultTranslator, type Translator } from '../i18n';

export type SourceKind = 'steam' | 'heroic' | 'lutris' | 'external' | 'manual';

export interface SourceInfo {
  kind: SourceKind;
  /** Badge text. */
  label: string;
  /** Longer description for the tooltip / accessible name. */
  detail: string;
}

const STORE_NAMES: Record<string, string> = {
  epic: 'Epic Games',
  gog: 'GOG',
  ubisoft: 'Ubisoft Connect',
  ea: 'EA app',
  battlenet: 'Battle.net',
  xbox: 'Xbox',
  minecraft: 'Minecraft',
  emulator: 'Emulator',
};

/**
 * Maps Game.source onto the five badge kinds shown in the library.
 * Returns null when the game has no source recorded (no badge is shown).
 */
export function sourceInfo(game: Pick<Game, 'source'>, t: Translator = defaultTranslator): SourceInfo | null {
  switch (game.source) {
    case undefined:
      return null;
    case 'steam':
      return { kind: 'steam', label: 'Steam', detail: t('source.steamDetail') };
    case 'heroic':
      return { kind: 'heroic', label: 'Heroic', detail: t('source.heroicDetail') };
    case 'lutris':
      return { kind: 'lutris', label: 'Lutris', detail: t('source.lutrisDetail') };
    case 'manual':
      return { kind: 'manual', label: t('source.manual'), detail: t('source.manualDetail') };
    default: {
      const store = game.source === 'emulator' ? t('source.emulator') : (STORE_NAMES[game.source] ?? game.source);
      return { kind: 'external', label: t('source.external'), detail: t('source.externalDetail', { store }) };
    }
  }
}

/** The save folder: linPath first, then winPath. Empty string = no save folder found. */
export function savePathOf(game: Pick<Game, 'linPath' | 'winPath'>): string {
  return (game.linPath || game.winPath || '').trim();
}

/** Install folder, or empty string when the scanner did not report one. */
export function installPathOf(game: Pick<Game, 'installPath'>): string {
  return (game.installPath ?? '').trim();
}
