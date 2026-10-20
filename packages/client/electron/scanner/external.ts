import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { nextId } from '@dune/shared';
import type { Game } from '@dune/shared';

function envRoots(name: string, defaults: string[]): string[] {
  const value = process.env[name];
  if (value) {
    return value.split(path.delimiter).map((entry) => entry.trim()).filter(Boolean);
  }
  return defaults.filter((candidate) => fs.existsSync(candidate));
}

function makeGame(name: string, installPath: string, source: NonNullable<Game['source']>): Game {
  const exists = fs.existsSync(installPath);
  const now = new Date().toISOString();
  return {
    id: nextId(),
    name,
    winPath: exists ? '' : installPath,
    linPath: exists ? installPath : '',
    lastSync: 'Never',
    status: 'Pending Upload',
    thumbnail: '',
    source,
    sourceId: source,
    createdAt: now,
    updatedAt: now,
  };
}

function scanDirectories(roots: string[], source: NonNullable<Game['source']>): Game[] {
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
      games.push(makeGame(entry.name, path.join(root, entry.name), source));
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

export function getEpicGames(roots: string[] = getEpicManifestRoots()): Game[] {
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
          games.push(makeGame(name, installLocation, 'epic'));
        }
      } catch {
        // Ignore malformed Epic manifests.
      }
    }
  }
  return games;
}

export function getGogGames(roots?: string[]): Game[] {
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
        games.push(makeGame(entry.name, installPath, 'gog'));
      }
    }
  }
  return games;
}

export function getUbisoftGames(roots?: string[]): Game[] {
  return scanDirectories(roots ?? envRoots('UBISOFT_GAMES_ROOTS', [
    path.join(os.homedir(), '.wine', 'drive_c', 'Program Files (x86)', 'Ubisoft', 'Ubisoft Game Launcher', 'games'),
    'C:\\Program Files (x86)\\Ubisoft\\Ubisoft Game Launcher\\games',
  ]), 'ubisoft');
}

export function getEaGames(roots?: string[]): Game[] {
  return scanDirectories(roots ?? envRoots('EA_GAMES_ROOTS', [
    path.join(os.homedir(), '.wine', 'drive_c', 'Program Files', 'EA Games'),
    path.join(os.homedir(), '.wine', 'drive_c', 'Program Files (x86)', 'Origin Games'),
    'C:\\Program Files\\EA Games',
    'C:\\Program Files (x86)\\Origin Games',
  ]), 'ea');
}

export function getBattleNetGames(roots?: string[]): Game[] {
  return scanDirectories(roots ?? envRoots('BATTLENET_GAMES_ROOTS', [
    path.join(os.homedir(), '.wine', 'drive_c', 'Program Files (x86)', 'Battle.net'),
    'C:\\Program Files (x86)\\Battle.net',
  ]), 'battlenet');
}

export function getXboxGames(roots?: string[]): Game[] {
  return scanDirectories(roots ?? envRoots('XBOX_GAMES_ROOTS', [
    'C:\\XboxGames',
    path.join(os.homedir(), '.wine', 'drive_c', 'XboxGames'),
  ]), 'xbox');
}

export function getMinecraftGames(roots?: string[]): Game[] {
  const resolvedRoots = roots ?? envRoots('MINECRAFT_ROOTS', [
    path.join(os.homedir(), '.minecraft'),
  ]);
  const games: Game[] = [];
  for (const root of resolvedRoots) {
    if (!fs.existsSync(root)) continue;
    games.push(makeGame('Minecraft', root, 'minecraft'));

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
          games.push(makeGame(`Minecraft ${entry.name}`, path.join(instancesRoot, entry.name), 'minecraft'));
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
          games.push(makeGame(entry.name, path.join(curseforgeRoot, entry.name), 'minecraft'));
        }
      }
    }
  }
  return games;
}
