import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { nextId } from '@dune/shared';
import type { Game } from '@dune/shared';
import { toSaveFields, type SaveResolver } from './savePaths.js';

function envRoots(name: string, defaults: string[]): string[] {
  const value = process.env[name];
  if (value) {
    return value.split(path.delimiter).map((entry) => entry.trim()).filter(Boolean);
  }
  return defaults.filter((candidate) => fs.existsSync(candidate));
}

/**
 * Build a scanner Game. installPath holds the install folder; winPath/linPath
 * are save paths resolved from the Ludusavi manifest, or empty when unknown.
 */
function makeGame(
  name: string,
  installPath: string,
  source: NonNullable<Game['source']>,
  resolver: SaveResolver | null | undefined,
): Game {
  const now = new Date().toISOString();
  const savePath = resolver ? resolver.resolve({ name, installPath }) : '';
  return {
    id: nextId(),
    name,
    ...toSaveFields(savePath, resolver?.platform ?? process.platform),
    installPath,
    lastSync: 'Never',
    status: 'Pending Upload',
    thumbnail: '',
    source,
    sourceId: source,
    createdAt: now,
    updatedAt: now,
  };
}

function scanDirectories(roots: string[], source: NonNullable<Game['source']>, resolver?: SaveResolver | null): Game[] {
  const games: Game[] = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      games.push(makeGame(entry.name, path.join(root, entry.name), source, resolver));
    }
  }
  return games;
}

export function getEpicManifestRoots(): string[] {
  const home = os.homedir();
  return envRoots('EPIC_MANIFEST_ROOTS', [
    path.join(home, '.wine', 'drive_c', 'ProgramData', 'Epic', 'EpicGamesLauncher', 'Data', 'Manifests'),
    path.join(home, '.local', 'share', 'Epic', 'EpicGamesLauncher', 'Data', 'Manifests'),
    'C:\\ProgramData\\Epic\\EpicGamesLauncher\\Data\\Manifests',
  ]);
}

export function getEpicGames(roots: string[] = getEpicManifestRoots(), resolver?: SaveResolver | null): Game[] {
  const games: Game[] = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.item')) continue;
      try {
        const manifest = JSON.parse(fs.readFileSync(path.join(root, entry.name), 'utf-8')) as {
          DisplayName?: string;
          AppName?: string;
          InstallLocation?: string;
        };
        const name = manifest.DisplayName || manifest.AppName || path.basename(entry.name, '.item');
        const installLocation = manifest.InstallLocation || '';
        if (installLocation) {
          games.push(makeGame(name, installLocation, 'epic', resolver));
        }
      } catch {
        // Ignore malformed Epic manifests.
      }
    }
  }
  return games;
}

export function getGogGames(roots?: string[], resolver?: SaveResolver | null): Game[] {
  const resolvedRoots = roots ?? envRoots('GOG_GAMES_ROOTS', [
    path.join(os.homedir(), '.wine', 'drive_c', 'GOG Games'),
    path.join(os.homedir(), 'GOG Games'),
    'C:\\GOG Games',
    'C:\\Program Files (x86)\\GOG Galaxy\\Games',
  ]);
  const games: Game[] = [];
  for (const root of resolvedRoots) {
    if (!fs.existsSync(root)) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const installPath = path.join(root, entry.name);
      const hasGogMarker = fs.readdirSync(installPath).some((file) => /^goggame-.*\.info$/i.test(file) || file.toLowerCase() === 'gog_game.info');
      if (hasGogMarker) {
        games.push(makeGame(entry.name, installPath, 'gog', resolver));
      }
    }
  }
  return games;
}

export function getUbisoftGames(roots?: string[], resolver?: SaveResolver | null): Game[] {
  return scanDirectories(roots ?? envRoots('UBISOFT_GAMES_ROOTS', [
    path.join(os.homedir(), '.wine', 'drive_c', 'Program Files (x86)', 'Ubisoft', 'Ubisoft Game Launcher', 'games'),
    'C:\\Program Files (x86)\\Ubisoft\\Ubisoft Game Launcher\\games',
  ]), 'ubisoft', resolver);
}

export function getEaGames(roots?: string[], resolver?: SaveResolver | null): Game[] {
  return scanDirectories(roots ?? envRoots('EA_GAMES_ROOTS', [
    path.join(os.homedir(), '.wine', 'drive_c', 'Program Files', 'EA Games'),
    path.join(os.homedir(), '.wine', 'drive_c', 'Program Files (x86)', 'Origin Games'),
    'C:\\Program Files\\EA Games',
    'C:\\Program Files (x86)\\Origin Games',
  ]), 'ea', resolver);
}

export function getBattleNetGames(roots?: string[], resolver?: SaveResolver | null): Game[] {
  return scanDirectories(roots ?? envRoots('BATTLENET_GAMES_ROOTS', [
    path.join(os.homedir(), '.wine', 'drive_c', 'Program Files (x86)', 'Battle.net'),
    'C:\\Program Files (x86)\\Battle.net',
  ]), 'battlenet', resolver);
}

export function getXboxGames(roots?: string[], resolver?: SaveResolver | null): Game[] {
  return scanDirectories(roots ?? envRoots('XBOX_GAMES_ROOTS', [
    'C:\\XboxGames',
    path.join(os.homedir(), '.wine', 'drive_c', 'XboxGames'),
  ]), 'xbox', resolver);
}

export function getMinecraftGames(roots?: string[], resolver?: SaveResolver | null): Game[] {
  const resolvedRoots = roots ?? envRoots('MINECRAFT_ROOTS', [
    path.join(os.homedir(), '.minecraft'),
  ]);
  const games: Game[] = [];
  for (const root of resolvedRoots) {
    if (!fs.existsSync(root)) continue;
    games.push(makeGame('Minecraft', root, 'minecraft', resolver));

    const instancesRoot = path.join(root, 'versions');
    if (fs.existsSync(instancesRoot)) {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(instancesRoot, { withFileTypes: true });
      } catch {
        entries = [];
      }
      for (const entry of entries) {
        if (entry.isDirectory()) {
          games.push(makeGame(`Minecraft ${entry.name}`, path.join(instancesRoot, entry.name), 'minecraft', resolver));
        }
      }
    }

    const curseforgeRoot = path.join(os.homedir(), '.curseforge', 'minecraft', 'Instances');
    if (fs.existsSync(curseforgeRoot)) {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(curseforgeRoot, { withFileTypes: true });
      } catch {
        entries = [];
      }
      for (const entry of entries) {
        if (entry.isDirectory()) {
          games.push(makeGame(entry.name, path.join(curseforgeRoot, entry.name), 'minecraft', resolver));
        }
      }
    }
  }
  return games;
}
