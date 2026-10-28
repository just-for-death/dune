import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SaveVersion } from '@dune/shared';
import { SaveVersionTimeline } from './SaveVersionTimeline';

// Node environment (no DOM): static markup covers labels, sizes and busy state.
const version = (id: string, sizeBytes: number, createdAt = '2026-01-01T00:00:00.000Z'): SaveVersion => ({
  id,
  gameId: 1,
  createdAt,
  sizeBytes,
  fileCount: 2,
  changeSummary: '',
  status: 'complete',
});

describe('SaveVersionTimeline', () => {
  it('shows sizes with formatBytes, not a fixed MB', () => {
    const html = renderToStaticMarkup(<SaveVersionTimeline versions={[version('v1', 20 * 1024)]} />);
    expect(html).toContain('20.0 KB');
    expect(html).not.toContain('0.0 MB');
  });

  it('never shows "Invalid Date" for a bad timestamp', () => {
    const html = renderToStaticMarkup(<SaveVersionTimeline versions={[version('v1', 1, 'garbage')]} />);
    expect(html).not.toContain('Invalid Date');
  });

  it('is not busy and offers Restore when nothing is restoring', () => {
    const html = renderToStaticMarkup(<SaveVersionTimeline versions={[version('v2', 1), version('v1', 1)]} onRestore={vi.fn()} />);
    expect(html).not.toContain('aria-busy');
    expect(html).not.toContain('aria-disabled');
    expect(html.match(/>Restore</g)).toHaveLength(2);
  });

  it('marks every Restore unavailable and names the running one while restoring', () => {
    const html = renderToStaticMarkup(<SaveVersionTimeline versions={[version('v2', 1), version('v1', 1)]} restoringId="v1" onRestore={vi.fn()} />);
    expect(html).toContain('aria-busy="true"');
    expect(html.match(/aria-disabled="true"/g)).toHaveLength(2);
    expect(html).toContain('Restoring…');
    expect(html).toContain('aria-label="Restoring version from');
  });
});
