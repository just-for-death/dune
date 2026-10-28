import { describe, it, expect } from 'vitest';
import { RARITY_TIERS } from '@dune/shared';
import { createTranslator } from './index';
import { rarityLabel } from './labels';

describe('rarityLabel (DUN-007)', () => {
  it('labels every shared tier from the catalog, including unknown', () => {
    const t = createTranslator('en');
    for (const tier of RARITY_TIERS) expect(rarityLabel(tier, t)).not.toBe('');
    expect(rarityLabel({ tier: 'unknown', label: 'Unknown' }, t)).toBe('Unknown rarity');
    expect(rarityLabel({ tier: 'unknown', label: 'Unknown' }, createTranslator('es'))).toBe('Rareza desconocida');
  });

  it('falls back to the sent label for tiers newer than the renderer', () => {
    const t = createTranslator('en');
    expect(rarityLabel({ tier: 'mythic' as never, label: 'Mythic' }, t)).toBe('Mythic');
  });
});
