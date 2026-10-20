import { expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/** Runs axe (WCAG 2.x A/AA) and fails on serious/critical violations; logs the rest. */
export async function expectNoSeriousViolations(page: Page, label: string, include?: string) {
  let builder = new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']);
  if (include) builder = builder.include(include);
  const results = await builder.analyze();
  const blocking = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  const minor = results.violations.filter((v) => !blocking.includes(v));
  if (minor.length) {
    console.log(`[axe:${label}] non-blocking: ${minor.map((v) => `${v.id} (${v.impact})`).join(', ')}`);
  }
  const summary = blocking.map((v) => ({
    id: v.id,
    impact: v.impact,
    help: v.help,
    targets: v.nodes.slice(0, 5).map((n) => n.target.join(' ')),
  }));
  expect(summary, `${label}: serious/critical axe violations`).toEqual([]);
}
