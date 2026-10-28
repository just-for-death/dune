import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { StorageEntry } from '@dune/shared';
import { StorageManager } from './StorageManager';

const entry: StorageEntry = { gameId: 7, saveBytes: 20 * 1024, cacheBytes: 3 * 1024 ** 3, lastPlayed: null, drive: '/' };

describe('StorageManager', () => {
  it('shows the game name and readable sizes', () => {
    const html = renderToStaticMarkup(<StorageManager drives={[]} entries={[entry]} gameName={(id) => (id === 7 ? 'Hades' : undefined)} />);
    expect(html).toContain('<td>Hades</td>');
    expect(html).not.toContain('Game #7');
    expect(html).toContain('20.0 KB');
    expect(html).toContain('3.0 GB');
  });

  it('falls back to the id for a game not in the library', () => {
    const html = renderToStaticMarkup(<StorageManager drives={[]} entries={[entry]} gameName={() => undefined} />);
    expect(html).toContain('Game #7');
  });

  it('formats drive sizes with formatBytes', () => {
    const html = renderToStaticMarkup(<StorageManager drives={[{ name: 'C:', totalBytes: 2 * 1024 ** 4, freeBytes: 512 * 1024 ** 2 }]} entries={[]} />);
    expect(html).toContain('512.0 MB free');
    expect(html).toContain('2.0 TB total');
  });
});
