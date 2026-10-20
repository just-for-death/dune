import { describe, expect, it } from 'vitest';
import {
  emulatorSetFailureMessage, fileName, launchReadiness, pickFailureMessage, prefixSetFailureMessage, usesEmulator, usesWinePrefix,
} from './launchSettings';

describe('launchReadiness', () => {
  it('launcher games are ready through their launcher', () => {
    expect(launchReadiness({ source: 'steam', steamAppId: '1145360' })).toMatchObject({ ready: true, via: 'steam' });
    expect(launchReadiness({ source: 'heroic', heroicId: 'x' })).toMatchObject({ ready: true, via: 'heroic' });
    expect(launchReadiness({ source: 'lutris', lutrisSlug: 'x' })).toMatchObject({ ready: true, via: 'lutris' });
  });
  it('manual games need an executable', () => {
    expect(launchReadiness({ source: 'manual' })).toEqual({ ready: false, needs: 'executable' });
    expect(launchReadiness({ source: 'manual', executable: '  ' })).toEqual({ ready: false, needs: 'executable' });
    expect(launchReadiness({ source: 'manual', executable: '/games/Hades/Hades.exe' })).toEqual({ ready: true, via: 'executable', label: 'Starts Hades.exe' });
    expect(launchReadiness({ source: 'steam' })).toEqual({ ready: false, needs: 'executable' });
  });
  it('emulator games need an emulator', () => {
    expect(launchReadiness({ source: 'emulator' })).toEqual({ ready: false, needs: 'emulator' });
    expect(launchReadiness({ source: 'emulator', emulator: 'retroarch' })).toMatchObject({ ready: true, via: 'emulator' });
  });
});

describe('helpers', () => {
  it('fileName handles both separators', () => {
    expect(fileName('C:\\Games\\Celeste\\Celeste.exe')).toBe('Celeste.exe');
    expect(fileName('/opt/game/run.sh/')).toBe('run.sh');
  });
  it('picks which selectors apply', () => {
    expect(usesWinePrefix({ source: 'manual' })).toBe(true);
    expect(usesWinePrefix({})).toBe(true);
    expect(usesWinePrefix({ source: 'steam' })).toBe(false);
    expect(usesEmulator({ source: 'emulator' })).toBe(true);
    expect(usesEmulator({ source: 'manual' })).toBe(false);
  });
  it('maps reason codes to plain text, cancelled to nothing', () => {
    expect(pickFailureMessage('cancelled')).toBeNull();
    for (const r of ['not-found', 'invalid', 'error', 'weird', undefined]) expect(pickFailureMessage(r)).toMatch(/\.$/);
    expect(prefixSetFailureMessage('prefix-not-found')).toMatch(/no longer exists/);
    expect(emulatorSetFailureMessage('not-emulator')).not.toContain('not-emulator');
    expect(emulatorSetFailureMessage('__proto__')).toBe(emulatorSetFailureMessage('error'));
  });
});
