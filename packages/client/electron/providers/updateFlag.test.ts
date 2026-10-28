import { describe, it, expect } from 'vitest';
import { isUpdateCheckEnabled } from './updateFlag';

describe('isUpdateCheckEnabled (automatic update checks only)', () => {
  it('is off by default and for anything but a literal true', () => {
    for (const s of [undefined, null, {}, [], 'x', { updateCheckEnabled: 'true' }, { updateCheckEnabled: 1 }, { updateCheckEnabled: false }]) {
      expect(isUpdateCheckEnabled(s)).toBe(false);
    }
  });

  it('is on only for updateCheckEnabled === true', () => {
    expect(isUpdateCheckEnabled({ updateCheckEnabled: true })).toBe(true);
  });

  it('reads no legacy key (no shim)', () => {
    expect(isUpdateCheckEnabled({ ['update' + 'Checks']: true })).toBe(false);
  });
});
