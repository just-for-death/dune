import { describe, expect, it, vi } from 'vitest';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ElectronAPI } from '@dune/shared';
import { SavePathSection, type SavePathSectionProps } from './App';
import { SavePathSuggestions, type SavePathSuggestionsProps } from './components/manifest/SavePathSuggestions';
import { en } from './i18n/en';

const game = { id: 7, linPath: '/home/u/.local/share/Game/save', winPath: '', installPath: '/games/Game' };
/** Only the methods the section touches; the cast keeps the fake small. */
const bridge = (extra: Record<string, unknown>) => ({ getManifestSuggestions: vi.fn(), ...extra }) as unknown as ElectronAPI;
const props = (api: ElectronAPI | null, onApplied = vi.fn(async () => {})): SavePathSectionProps => ({ game, api, onApplied });

/** The SavePathSuggestions element the section renders, if any. */
function suggestionsOf(node: ReactNode): ReactElement<SavePathSuggestionsProps> | null {
  if (Array.isArray(node)) {
    for (const n of node) { const found = suggestionsOf(n); if (found) return found; }
    return null;
  }
  if (!isValidElement<{ children?: ReactNode }>(node)) return null;
  if (node.type === SavePathSuggestions) return node as ReactElement<SavePathSuggestionsProps>;
  return suggestionsOf(node.props.children);
}

describe('SavePathSection (Saves tab mount)', () => {
  it('renders nothing while the bridge has no save-path setter', () => {
    expect(renderToStaticMarkup(<SavePathSection {...props(bridge({}))} />)).toBe('');
    expect(renderToStaticMarkup(<SavePathSection {...props(bridge({ setSavePath: 'nope' }))} />)).toBe('');
    expect(renderToStaticMarkup(<SavePathSection {...props(null)} />)).toBe('');
  });

  it('mounts the suggestions with the current save path once a setter exists', () => {
    const html = renderToStaticMarkup(<SavePathSection {...props(bridge({ setSavePath: vi.fn() }))} />);
    expect(html).toContain(en['manifest.title']);
    expect(html).toContain(en['manifest.findButton']);
    expect(html).toContain('id="save-path-7-title"');
    const el = suggestionsOf(SavePathSection(props(bridge({ setSavePath: vi.fn() }))));
    expect(el?.props.gameId).toBe('7');
    expect(el?.props.currentSavePath).toBe(game.linPath);
  });

  it('applies through setSavePath, then reloads the games', async () => {
    const setSavePath = vi.fn(async () => ({ ok: true }));
    const onApplied = vi.fn(async () => {});
    const el = suggestionsOf(SavePathSection(props(bridge({ setSavePath }), onApplied)));
    await el?.props.onApply('/new/path');
    expect(setSavePath).toHaveBeenCalledWith(7, '/new/path');
    expect(onApplied).toHaveBeenCalledTimes(1);
  });

  it('rejects (so the inline apply error shows) on an ok:false reply or a thrown call, without reloading', async () => {
    const onApplied = vi.fn(async () => {});
    const failed = suggestionsOf(SavePathSection(props(bridge({ setSavePath: vi.fn(async () => ({ ok: false, reason: 'error' })) }), onApplied)));
    await expect(failed?.props.onApply('/p')).rejects.toThrow();
    const thrown = suggestionsOf(SavePathSection(props(bridge({ setSavePath: vi.fn(async () => { throw new Error('ipc'); }) }), onApplied)));
    await expect(thrown?.props.onApply('/p')).rejects.toThrow();
    expect(onApplied).not.toHaveBeenCalled();
  });
});
