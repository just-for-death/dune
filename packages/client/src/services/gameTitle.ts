/**
 * Add-game title check: wraps validateGameTitle from @dune/shared and maps its
 * codes to plain wording. Any characters are allowed (colons, ™, quotes);
 * only empty, control characters and over-long titles are rejected.
 */
import { MAX_GAME_TITLE_LENGTH, validateGameTitle, type PathRuleCode } from '@dune/shared';

import { defaultTranslator, type MessageKey, type Translator } from '../i18n';

export type TitleCheck = { ok: true; value: string } | { ok: false; error: string };

const MESSAGES: Partial<Record<PathRuleCode, MessageKey>> = {
  EMPTY: 'gameTitle.empty',
  NUL: 'gameTitle.nul',
  CONTROL: 'gameTitle.control',
  TOO_LONG: 'gameTitle.tooLong',
};

export function checkGameTitle(input: string, t: Translator = defaultTranslator): TitleCheck {
  const result = validateGameTitle(input);
  if (result.ok) return { ok: true, value: result.value };
  const key = MESSAGES[result.code];
  return { ok: false, error: key ? t(key, { max: MAX_GAME_TITLE_LENGTH }) : t('gameTitle.invalid') };
}
