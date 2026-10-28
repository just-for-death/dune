import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AdminState } from '../../services/currentUser';

// No DOM here, so effects never run. To render loaded rows, the lists'
// initial 'loading' state is swapped for 'ready' with these items, in
// render order: sources, servers, then API keys (left empty).
const listQueue: unknown[][] = [];
vi.mock('react', async importOriginal => {
  const actual = await importOriginal<typeof import('react')>();
  const useState = ((init: unknown) => {
    const value = typeof init === 'function' ? (init as () => unknown)() : init;
    if (value && typeof value === 'object' && 'status' in value && 'items' in value && (value as { status: string }).status === 'loading') {
      return actual.useState({ status: 'ready', items: listQueue.shift() ?? [] });
    }
    return actual.useState(value);
  }) as typeof actual.useState;
  return { ...actual, useState, default: { ...actual, useState } };
});

const { WhereItRuns } = await import('./WhereItRuns');
const { I18nProvider } = await import('../../i18n/I18nProvider');

const NOTE = 'Only an admin can change this.';

function render(adminState: AdminState | undefined, withRows = true) {
  listQueue.length = 0;
  if (withRows) listQueue.push([{ id: 1, path: '/srv/games/saves' }], [{ id: 7, url: 'http://192.168.1.20:3030' }], []);
  return renderToStaticMarkup(
    <WhereItRuns
      serverUrl="http://localhost:3030"
      serverKeySet
      connectionVersion={0}
      serverUrlFieldId="server-url"
      serverKeyFieldId="server-key"
      adminState={adminState}
    />,
  );
}

/** The opening tag of the first <button> whose text (or aria-label) matches. */
function button(html: string, match: RegExp): string {
  for (const m of html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)) {
    if (match.test(m[0])) return m[0].slice(0, m[0].indexOf('>') + 1);
  }
  throw new Error(`no button matching ${match}`);
}

const attr = (tag: string, name: string) => tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];

const controls = {
  addSource: />Add source</,
  removeSource: /aria-label="Remove [^"]*\/srv\/games\/saves/,
  addServer: />Add server</,
  removeServer: /aria-label="Remove [^"]*192\.168\.1\.20/,
};

afterEach(() => { listQueue.length = 0; });

describe('WhereItRuns admin gating (DUN-115)', () => {
  it('disables source/server add and remove for a member, each described by visible admin-only text', () => {
    const html = render('member');
    for (const [name, match] of Object.entries(controls)) {
      const tag = button(html, match);
      expect(tag, name).toMatch(/\sdisabled=""/);
      const describedBy = attr(tag, 'aria-describedby');
      expect(describedBy, name).toBeTruthy();
      for (const id of describedBy!.split(' ')) {
        const note = html.match(new RegExp(`<p id="${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*>([^<]*)</p>`));
        expect(note?.[1], `${name} -> #${id}`).toBe(NOTE);
      }
    }
    // Two notes per section: one for the add form, one for the list's remove buttons.
    expect(html.split(NOTE).length - 1).toBe(4);
  });

  it('keeps the path/address inputs focusable for a member and points them at the note', () => {
    const html = render('member');
    const inputs = [...html.matchAll(/<input\b[^>]*>/g)].map(m => m[0]).filter(i => /placeholder="(\/srv|http)/.test(i));
    expect(inputs).toHaveLength(2);
    for (const input of inputs) {
      expect(input).not.toMatch(/\sdisabled=""/);
      const ids = attr(input, 'aria-describedby')!.split(' ');
      expect(ids.some(id => html.includes(`<p id="${id}" class="form-hint">${NOTE}</p>`))).toBe(true);
    }
  });

  it('leaves every control enabled with no admin note for an admin', () => {
    const html = render('admin');
    for (const [name, match] of Object.entries(controls)) {
      const tag = button(html, match);
      expect(tag, name).not.toMatch(/\sdisabled=""/);
      expect(attr(tag, 'aria-describedby'), name).toBeUndefined();
    }
    expect(html).not.toContain(NOTE);
  });

  it('does not lock anything while the role is unknown (403 fallback handles it)', () => {
    for (const state of ['unknown', undefined] as const) {
      const html = render(state);
      for (const [name, match] of Object.entries(controls)) {
        expect(button(html, match), `${String(state)} ${name}`).not.toMatch(/\sdisabled=""/);
      }
      expect(html).not.toContain(NOTE);
    }
  });

  it('uses where.adminOnly (not the 403 where.needsAdmin text) and translates it', () => {
    const html = render('member');
    expect(html).not.toContain('Needs an admin key');
    listQueue.length = 0;
    const es = renderToStaticMarkup(
      <I18nProvider initialLocale="es">
        <WhereItRuns serverUrl="http://localhost:3030" serverKeySet connectionVersion={0} serverUrlFieldId="u" serverKeyFieldId="k" adminState="member" />
      </I18nProvider>,
    );
    expect(es).toContain('Solo un administrador puede cambiar esto.');
    expect(es).not.toContain(NOTE);
  });

  it('shows only the add-form notes for a member when the lists are empty', () => {
    const html = render('member', false);
    expect(html.split(NOTE).length - 1).toBe(2);
  });
});
