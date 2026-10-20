import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface DetectedEmulator {
  name: string;
  type: 'retroarch' | 'dolphin' | 'pcsx2' | 'rpcs3' | 'ppsspp' | 'duckstation';
  configDir: string;
  available: boolean;
}

function envOrPaths(name: string, defaults: string[]): string[] {
  const value = process.env[name];
  if (value) return value.split(path.delimiter).map((entry) => entry.trim()).filter(Boolean);
  return defaults;
}

function firstExisting(paths: string[]): string | null {
  for (const candidate of paths) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

export function getRetroArchConfigDir(): string | null {
  const home = os.homedir();
  return firstExisting(envOrPaths('RETROARCH_CONFIG_DIR', [
    path.join(home, '.config', 'retroarch'),
    path.join(home, '.var', 'app', 'org.libretro.RetroArch', 'config', 'retroarch'),
  ]));
}

export function getDolphinConfigDir(): string | null {
  const home = os.homedir();
  return firstExisting(envOrPaths('DOLPHIN_CONFIG_DIR', [
    path.join(home, '.config', 'dolphin-emu'),
    path.join(home, '.var', 'app', 'org.DolphinEmu.dolphin-emu', 'config', 'dolphin-emu'),
  ]));
}

export function getPcsx2ConfigDir(): string | null {
  const home = os.homedir();
  return firstExisting(envOrPaths('PCSX2_CONFIG_DIR', [
    path.join(home, '.config', 'PCSX2'),
    path.join(home, '.var', 'app', 'net.pcsx2.PCSX2', 'config', 'PCSX2'),
  ]));
}

export function getRpcs3ConfigDir(): string | null {
  const home = os.homedir();
  return firstExisting(envOrPaths('RPCS3_CONFIG_DIR', [
    path.join(home, '.config', 'rpcs3'),
    path.join(home, '.var', 'app', 'net.rpcs3.RPCS3', 'config', 'rpcs3'),
  ]));
}

export function getPpssppConfigDir(): string | null {
  const home = os.homedir();
  return firstExisting(envOrPaths('PPSSPP_CONFIG_DIR', [
    path.join(home, '.config', 'ppsspp'),
    path.join(home, '.var', 'app', 'org.ppsspp.PPSSPP', 'config', 'ppsspp'),
  ]));
}

export function getDuckStationConfigDir(): string | null {
  const home = os.homedir();
  return firstExisting(envOrPaths('DUCKSTATION_CONFIG_DIR', [
    path.join(home, '.config', 'duckstation'),
    path.join(home, '.var', 'app', 'org.duckstation.DuckStation', 'config', 'duckstation'),
  ]));
}

export function detectEmulators(): DetectedEmulator[] {
  const checks: Array<[string, DetectedEmulator['type'], string | null]> = [
    ['RetroArch', 'retroarch', getRetroArchConfigDir()],
    ['Dolphin', 'dolphin', getDolphinConfigDir()],
    ['PCSX2', 'pcsx2', getPcsx2ConfigDir()],
    ['RPCS3', 'rpcs3', getRpcs3ConfigDir()],
    ['PPSSPP', 'ppsspp', getPpssppConfigDir()],
    ['DuckStation', 'duckstation', getDuckStationConfigDir()],
  ];

  return checks
    .filter(([, , configDir]) => Boolean(configDir))
    .map(([name, type, configDir]) => ({
      name,
      type,
      configDir: configDir as string,
      available: true,
    }));
}
