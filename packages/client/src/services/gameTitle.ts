/**
 * Add-game title check: wraps validateGameTitle from @dune/shared and maps its
 * codes to plain wording. Any characters are allowed (colons, ™, quotes);
 * only empty, control characters and over-long titles are rejected.
 */
import { MAX_GAME_TITLE_LENGTH, validateGameTitle, type PathRuleCode } from '@dune/shared';

export type TitleCheck = { ok: true; value: string } | { ok: false; error: string };

const MESSAGES: Partial<Record<PathRuleCode, string>> = {
  EMPTY: 'Enter the game title.',
  NUL: 'The title contains a hidden character. Retype it.',
  CONTROL: 'The title contains hidden characters such as tabs or line breaks. Retype it.',
  TOO_LONG: `Use at most ${MAX_GAME_TITLE_LENGTH} characters.`,
};

export function checkGameTitle(input: string): TitleCheck {
  const result = validateGameTitle(input);
  if (result.ok) return { ok: true, value: result.value };
  return { ok: false, error: MESSAGES[result.code] ?? 'This title cannot be used.' };
}
