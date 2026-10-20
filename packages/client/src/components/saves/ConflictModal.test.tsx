import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ConflictRecord, SaveVersion } from '@dune/shared';
import { ConflictModal } from './ConflictModal';

// Node environment (no DOM): static markup covers labels and ARIA wiring.
// Focus management, Escape and focus restore are covered in e2e/keyboard.spec.ts.
const conflict: ConflictRecord = {
  id: 'c1',
  gameId: 1,
  localVersionId: 'v1',
  remoteVersionId: 'v2',
  detectedAt: '2026-01-01T00:00:00.000Z',
};

const version = (id: string, sizeBytes: number): SaveVersion => ({
  id,
  gameId: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  sizeBytes,
  fileCount: 3,
  changeSummary: '',
  status: 'complete',
});

const render = (open: boolean, c: ConflictRecord | null = conflict) =>
  renderToStaticMarkup(
    <ConflictModal
      conflict={c}
      localVersion={version('v1', 6.6 * 1024 * 1024)}
      remoteVersion={version('v2', 512)}
      open={open}
      onClose={() => {}}
      onResolve={() => {}}
    />,
  );

describe('ConflictModal', () => {
  it('renders a native dialog labelled by its title', () => {
    const html = render(true);
    expect(html).toMatch(/^<dialog/);
    const labelledBy = html.match(/aria-labelledby="([^"]+)"/)?.[1];
    expect(labelledBy).toBeTruthy();
    expect(html).toContain(`id="${labelledBy}"`);
    expect(html).toMatch(new RegExp(`id="${labelledBy}"[^>]*>Save conflict detected<`));
  });

  it('uses explicit action labels', () => {
    const html = render(true);
    for (const label of ['Keep local copy', 'Keep server copy', 'Keep both', 'Decide later']) {
      expect(html).toContain(`>${label}</button>`);
    }
    expect(html).not.toContain('Keep this one');
    expect(html.toLowerCase()).not.toContain('cloud');
  });

  it('shows human-readable sizes', () => {
    const html = render(true);
    expect(html).toContain('3 files · 6.6 MB');
    expect(html).toContain('3 files · 512 B');
  });

  it('renders no content while closed or without a conflict', () => {
    expect(render(false)).not.toContain('Save conflict detected');
    expect(render(true, null)).not.toContain('Save conflict detected');
  });
});
