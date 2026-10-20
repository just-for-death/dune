import type { EmulatorInfo } from '@dune/shared';
import { KNOWN_EMULATOR_COMMANDS } from '../emulators/roms.js';

/**
 * DUN-061: the emulators a game may be launched with. Ids are the known
 * emulator commands from `emulators/roms.ts`; the renderer picks one by id
 * and never supplies a command or path.
 */
const DISPLAY_NAMES: Record<string, string> = {
  retroarch: 'RetroArch',
  mesen: 'Mesen',
  'snes9x-gtk': 'Snes9x',
  mupen64plus: 'Mupen64Plus',
  rmg: 'Rosalie\'s Mupen GUI',
  sameboy: 'SameBoy',
  'mgba-qt': 'mGBA',
  melonds: 'melonDS',
  desmume: 'DeSmuME',
  'citra-qt': 'Citra (Qt)',
  citra: 'Citra',
  ppsspp: 'PPSSPP',
  PPSSPPSDL: 'PPSSPP (SDL)',
  'duckstation-qt': 'DuckStation (Qt)',
  duckstation: 'DuckStation',
  pcsx2: 'PCSX2',
  rpcs3: 'RPCS3',
  'dolphin-emu': 'Dolphin',
};

const KNOWN: ReadonlySet<string> = new Set(KNOWN_EMULATOR_COMMANDS);

export function isKnownEmulator(id: unknown): id is string {
  return typeof id === 'string' && KNOWN.has(id);
}

export function listKnownEmulators(): EmulatorInfo[] {
  return KNOWN_EMULATOR_COMMANDS.map((id) => ({ id, name: DISPLAY_NAMES[id] ?? id }));
}
