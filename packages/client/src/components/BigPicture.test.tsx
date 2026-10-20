import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Game } from '@dune/shared';
import { BigPicture } from './BigPicture';

const game = (id: number, name: string, thumbnail = ''): Game => ({
  id,
  name,
  winPath: '',
  linPath: `/tmp/${id}`,
  lastSync: 'Never',
  status: 'Pending Upload',
  thumbnail,
  createdAt: '',
  updatedAt: '',
});

// Arrow-key navigation, autofocus and Enter-to-launch are covered in
// e2e/keyboard.spec.ts; these check the static structure.
describe('BigPicture', () => {
  it('shows an empty state when there are no games', () => {
    const html = renderToStaticMarkup(<BigPicture games={[]} />);
    expect(html).toContain('No games in your library yet.');
    expect(html).not.toContain('big-picture-card');
  });

  it('uses a roving tabindex with only the first card tabbable', () => {
    const html = renderToStaticMarkup(<BigPicture games={[game(1, 'A'), game(2, 'B'), game(3, 'C')]} />);
    const tabIndexes = [...html.matchAll(/class="big-picture-card"[^>]*tabindex="(-?\d)"/g)].map((m) => m[1]);
    expect(tabIndexes).toEqual(['0', '-1', '-1']);
  });

  it('renders thumbnails as decorative images', () => {
    const html = renderToStaticMarkup(<BigPicture games={[game(1, 'Hades', 'file:///cover.png')]} />);
    expect(html).toMatch(/<img[^>]*src="file:\/\/\/cover.png"[^>]*>/);
    expect(html).toMatch(/<img[^>]*alt=""/);
    expect(html).toContain('>Hades</span>');
  });
});
