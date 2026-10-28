import { describe, expect, it } from 'vitest';
import { isProviderDisabled } from './hltbStatus';

describe('isProviderDisabled', () => {
  it('recognises the 403 PROVIDER_DISABLED ServerFailure', () => {
    expect(isProviderDisabled({ ok: false, status: 403, code: 'PROVIDER_DISABLED', message: 'off' })).toBe(true);
  });

  it('recognises main\'s local pre-check (same code, no HTTP status)', () => {
    expect(isProviderDisabled({ ok: false, code: 'PROVIDER_DISABLED', message: 'off' })).toBe(true);
  });

  it('no longer treats the old 200 { success:false, code } shape as disabled', () => {
    expect(isProviderDisabled({ ok: true, success: false, code: 'PROVIDER_DISABLED', message: 'off' })).toBe(false);
  });

  it('ignores successes, other failures and junk', () => {
    expect(isProviderDisabled({ ok: true, success: true, times: { mainStory: 1 } })).toBe(false);
    expect(isProviderDisabled({ ok: true, success: true, code: 'PROVIDER_DISABLED' })).toBe(false);
    expect(isProviderDisabled({ ok: false, status: 500, code: 'PROVIDER_DISABLED', message: 'x' })).toBe(false);
    expect(isProviderDisabled({ ok: false, status: 403, code: 'FORBIDDEN', message: 'x' })).toBe(false);
    expect(isProviderDisabled({ ok: false, code: 'ARTWORK_DISABLED', message: 'x' })).toBe(false);
    expect(isProviderDisabled({ ok: false, code: 'NETWORK', message: 'x' })).toBe(false);
    expect(isProviderDisabled(new Error('PROVIDER_DISABLED'))).toBe(false);
    expect(isProviderDisabled(null)).toBe(false);
    expect(isProviderDisabled('PROVIDER_DISABLED')).toBe(false);
  });
});
