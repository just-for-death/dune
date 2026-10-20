import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { BackupProfile } from '@dune/shared';
import { ExclusionEditor } from './ExclusionEditor';

const profile = (excludeGlobs: string[]): BackupProfile => ({
  gameId: 1,
  includeGlobs: ['**/*'],
  excludeGlobs,
  autoExcludeCache: true,
  updatedAt: '2026-01-01T00:00:00.000Z',
});

const files = [
  { path: 'saves/slot1.sav', size: 6.6 * 1024 * 1024, category: 'Save' as const },
  { path: 'settings.ini', size: 2048, category: 'Config' as const },
  { path: 'ShaderCache/file.bin', size: 412 * 1024 * 1024, category: 'Cache' as const },
  { path: 'readme.txt', size: 10, category: 'Other' as const },
];

const render = (globs: string[]) =>
  renderToStaticMarkup(<ExclusionEditor profile={profile(globs)} files={files} onChange={() => {}} />);

/** The <label class="exclusion-row"> markup for one category. */
const row = (html: string, category: string) =>
  html.split('<label').find((chunk) => chunk.includes(`<strong>${category}</strong>`)) ?? '';

describe('ExclusionEditor', () => {
  it('reassures that nothing is deleted locally', () => {
    expect(render([])).toContain('Nothing is deleted from your PC.');
  });

  it('formats sizes for humans instead of raw bytes', () => {
    const html = render(['**/cache/**']);
    expect(html).toContain('1 file · 6.6 MB');
    expect(html).toContain('1 file · 2.0 KB');
    expect(html).toContain('1 file · 412.0 MB');
    // Cache excluded: 6.6 MB + 2 KB + 10 B included
    expect(html).toContain('6.6 MB included');
    expect(html).not.toMatch(/\d+ bytes included/);
  });

  it('derives excluded categories from the profile globs', () => {
    const html = render(['**/*.ini', '**/cache/**']);
    expect(row(html, 'Config')).toContain('checked=""');
    expect(row(html, 'Cache')).toContain('checked=""');
    expect(row(html, 'Save')).not.toContain('checked=""');
  });

  it('only lets categories with real glob patterns be toggled', () => {
    const html = render([]);
    for (const category of ['Save', 'Config', 'Cache']) {
      expect(row(html, category)).not.toContain('disabled=""');
    }
    expect(row(html, 'Other')).toContain('disabled=""');
    expect(row(html, 'Other')).toContain('always included');
  });
});
