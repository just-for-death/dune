import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { GamePathInfo, SourceBadge } from './GamePathInfo';

describe('GamePathInfo', () => {
  it('shows save and install folders with full-text titles', () => {
    const html = renderToStaticMarkup(
      <GamePathInfo game={{ linPath: '/home/jane/.local/share/Hades', winPath: '', installPath: '/games/Hades' }} />,
    );
    expect(html).toContain('<dt>Save path</dt>');
    expect(html).toContain('title="/home/jane/.local/share/Hades"');
    expect(html).toContain('<dt>Install folder</dt>');
    expect(html).toContain('title="/games/Hades"');
  });

  it('falls back to winPath', () => {
    const html = renderToStaticMarkup(<GamePathInfo game={{ linPath: '', winPath: 'C:\\Saves\\Hades' }} />);
    expect(html).toContain('>C:\\Saves\\Hades</code>');
  });

  it('says when no save folder was found', () => {
    const html = renderToStaticMarkup(<GamePathInfo game={{ linPath: '', winPath: '', installPath: '/games/X' }} />);
    expect(html).toContain('No save folder found');
    expect(html).not.toContain('<code class="path-value" title="">');
  });

  it('hides the install row when installPath is unset', () => {
    const html = renderToStaticMarkup(<GamePathInfo game={{ linPath: '/saves', winPath: '' }} />);
    expect(html).not.toContain('Install folder');
  });
});

describe('SourceBadge', () => {
  it('renders readable text with an accessible prefix', () => {
    const html = renderToStaticMarkup(<SourceBadge game={{ source: 'heroic' }} />);
    expect(html).toContain('source-heroic');
    expect(html).toContain('Source: </span>Heroic');
  });

  it('renders nothing without a source', () => {
    expect(renderToStaticMarkup(<SourceBadge game={{}} />)).toBe('');
  });
});
