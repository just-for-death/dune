import { describe, expect, it } from 'vitest';
import { formatBytes, formatDate } from './format';

describe('formatBytes', () => {
  it('picks a unit instead of a fixed MB', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(20 * 1024)).toBe('20.0 KB');
    expect(formatBytes(1.5 * 1024 ** 3)).toBe('1.5 GB');
  });

  it('treats junk as 0 B', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(-5)).toBe('0 B');
    expect(formatBytes(Number.NaN)).toBe('0 B');
  });
});

describe('formatDate', () => {
  it('formats a valid timestamp for the locale', () => {
    const iso = '2026-01-02T03:04:05.000Z';
    expect(formatDate(iso, 'en')).toBe(new Date(iso).toLocaleString('en'));
  });

  it('reads empty and "Never" as never', () => {
    expect(formatDate('', 'en')).toBe('Never');
    expect(formatDate(null, 'en')).toBe('Never');
    expect(formatDate('Never', 'en')).toBe('Never');
  });

  it('never shows "Invalid Date" for a value that does not parse', () => {
    expect(formatDate('not-a-date', 'en')).toBe('not-a-date');
  });
});
