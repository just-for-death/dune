import * as fs from 'fs';
import * as path from 'path';

export interface EmulatorSave {
  emulator: string;
  type: 'battery' | 'state';
  path: string;
  game?: string;
}

export function findFilesByExtensions(root: string, extensions: string[]): string[] {
  const results: string[] = [];
  if (!fs.existsSync(root)) return results;
  const wanted = new Set(extensions.map((ext) => ext.toLowerCase()));
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (wanted.has(path.extname(entry.name).toLowerCase())) results.push(full);
    }
  }
  return results;
}

export function getRetroArchSaveStates(configDir: string): EmulatorSave[] {
  const statesDir = path.join(configDir, 'states');
  return findFilesByExtensions(statesDir, ['.state', '.state1', '.state2', '.state3', '.state4', '.state5', '.state6', '.state7', '.state8', '.state9'])
    .map((filePath) => ({ emulator: 'RetroArch', type: 'state' as const, path: filePath, game: path.basename(filePath, path.extname(filePath)) }));
}

export function getRetroArchBatterySaves(configDir: string): EmulatorSave[] {
  const savesDir = path.join(configDir, 'saves');
  return findFilesByExtensions(savesDir, ['.srm', '.sav'])
    .map((filePath) => ({ emulator: 'RetroArch', type: 'battery' as const, path: filePath, game: path.basename(filePath, path.extname(filePath)) }));
}

/**
 * Predict the battery-save path RetroArch uses for a ROM. Prefers an existing
 * `.sav`/`.srm` file and otherwise returns the default `.srm` path so save
 * sync picks it up once the game creates it.
 */
export function getRetroArchSavePath(romPath: string, configDir: string | null): string | null {
  if (!configDir) return null;
  const savesDir = path.join(configDir, 'saves');
  const base = path.basename(romPath, path.extname(romPath));
  for (const extension of ['.srm', '.sav']) {
    const candidate = path.join(savesDir, base + extension);
    if (fs.existsSync(candidate)) return candidate;
  }
  return path.join(savesDir, base + '.srm');
}
