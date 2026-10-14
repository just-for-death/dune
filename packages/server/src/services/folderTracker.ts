import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { EventEmitter } from 'events';
import { getConfig } from '../utils/config.js';
import { logger } from '../middleware/logging.js';

export interface GameFolder {
  id: string;
  name: string;
  path: string;
  platform: 'steam' | 'epic' | 'gog' | 'origin' | 'ubisoft' | 'battle.net' | 'itch' | 'other';
  lastScanned: Date;
  gameFolders: GameFolderInfo[];
  totalSize: number;
  lastSync: Date | null;
}

export interface GameFolderInfo {
  id: string;
  name: string;
  path: string;
  size: number;
  gameCount: number;
  lastModified: Date;
  platform: string;
}

export interface FolderTrackerOptions {
  watchDirs?: string[];
  scanInterval?: number;
  onChange?: (folders: GameFolder[]) => void;
  onError?: (error: Error) => void;
}

interface WatchedDirectory {
  path: string;
  watcher: fs.FSWatcher;
  lastScan: Date;
}

/**
 * Folder tracker for game folders with auto-discovery and organization
 */
export class FolderTracker extends EventEmitter {
  private watchDirs: string[] = [];
  private scanIntervalMs: number = 300000; // 5 minutes
  private watchers: Map<string, WatchedDirectory> = new Map();
  private folders: Map<string, GameFolder> = new Map();
  private autoScanTimer: NodeJS.Timeout | null = null;
  private debounceTimers: Map<string, NodeJS.Timeout> = new Map();
  private configChangeHandler: (() => void) | null = null;
  private configManagerForUnsub: { off: (event: string, listener: () => void) => void } | null = null;
  private options: FolderTrackerOptions;

  constructor(options: FolderTrackerOptions = {}) {
    super();
    this.options = {
      scanInterval: 300000, // 5 minutes
      ...options,
    };
    this.scanIntervalMs = this.options.scanInterval ?? 300000;
    
    // Initialize with configured watch dirs or defaults
    this.initWatchDirs();
  }

  private getWatchDirs(): string[] {
    const config = getConfig();
    const watchDirs = config.data.watchDirs || [];
    
    // Add default game directories
    const homeDir = process.env.HOME || process.env.USERPROFILE || '';
    const defaultDirs = [
      path.join(homeDir, 'Games'),
      path.join(homeDir, 'Games', 'Steam'),
      path.join(homeDir, '.steam', 'steam', 'steamapps', 'common'),
      path.join(homeDir, '.local', 'share', 'Steam', 'steamapps', 'common'),
      path.join(homeDir, '.local', 'share', 'Steam', 'steamapps', 'compatdata'),
      path.join(homeDir, '.local', 'share', 'lutris'),
      path.join(homeDir, '.local', 'share', 'lutris', 'games'),
      path.join(homeDir, '.var', 'app', 'com.valvesoftware.Steam', 'data', 'Steam', 'steamapps', 'common'),
      '/mnt/Games',
      '/mnt/Games/Steam',
      '/mnt/Games/Epic',
      '/mnt/Games/GOG',
    ];

    return [...new Set([...this.options.watchDirs || [], ...defaultDirs, ...watchDirs])]
      .filter(dir => fs.existsSync(dir));
  }

  private initWatchDirs(): void {
    this.watchDirs = this.getWatchDirs();
    this.setupWatchers();
  }

  private setupWatchers(): void {
    const watchDirs = this.getWatchDirs();
    
    for (const dir of watchDirs) {
      if (!fs.existsSync(dir)) continue;
      if (this.watchers.has(dir)) continue;
      
      try {
        // NOTE: recursive fs.watch only works on macOS/Windows.
        // On Linux it watches the top dir only — deep changes arrive
        // via the periodic scanAll, not the watcher. Do not set
        // recursive:true and assume nested coverage.
        const watcher = fs.watch(dir, { recursive: false, persistent: true }, (eventType, filename) => {
          if (eventType === 'rename' || eventType === 'change') {
            this.handleFileChange(dir, filename);
          }
        });
        if (typeof (watcher as unknown as { unref?: () => void }).unref === 'function') {
          (watcher as unknown as { unref: () => void }).unref();
        }

        this.watchers.set(dir, {
          path: dir,
          watcher,
          lastScan: new Date(),
        });

        this.emit('watcherAdded', dir);
      } catch (error) {
        logger.error({ err: error, dir }, 'Failed to watch directory');
      }
    }
  }

  private handleFileChange(dir: string, filename: string | null): void {
    if (!filename) return;
    
    // Debounce rapid changes per directory; tracked so stop() can cancel.
    const prev = this.debounceTimers.get(dir);
    if (prev) clearTimeout(prev);
    const timer = setTimeout(() => {
      this.debounceTimers.delete(dir);
      void this.scanDirectory(dir);
    }, 1000);
    if (typeof (timer as unknown as { unref?: () => void }).unref === 'function') {
      (timer as unknown as { unref: () => void }).unref();
    }
    this.debounceTimers.set(dir, timer);
  }

  async scanDirectory(dirPath: string): Promise<GameFolder | null> {
    if (!fs.existsSync(dirPath)) return null;

    try {
      const folderName = path.basename(dirPath);
      
      // Determine platform from path
      const platform = this.detectPlatform(dirPath);
      
      // Find game folders (directories that contain game files)
      const gameFolders = await this.scanGameFolders(dirPath);
      
      const totalSize = this.calculateDirectorySize(dirPath);
      
      const folder: GameFolder = {
        id: this.generateId(dirPath),
        name: folderName,
        path: dirPath,
        platform,
        lastScanned: new Date(),
        gameFolders,
        totalSize,
        lastSync: new Date(),
      };

      this.folders.set(dirPath, folder);
      this.emit('folderScanned', folder);
      
      return folder;
    } catch (error) {
      logger.error({ err: error, dir: dirPath }, 'Failed to scan directory');
      if (this.listenerCount('error') > 0) {
        this.emit('error', error);
      }
      return null;
    }
  }

  private async scanGameFolders(dirPath: string): Promise<GameFolderInfo[]> {
    const gameFolders: GameFolderInfo[] = [];
    
    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith('.')) continue;
        
        const entryPath = path.join(dirPath, entry.name);
        
        try {
          const stats = fs.statSync(entryPath);
          
          // Check if it's a game folder (has executable, save files, etc.)
          const isGame = await this.analyzeGameFolder(entryPath);
          
          if (isGame) {
            gameFolders.push({
              id: this.generateId(entryPath),
              name: entry.name,
              path: entryPath,
              size: this.calculateDirectorySize(entryPath),
              gameCount: 1,
              lastModified: stats.mtime,
              platform: this.detectPlatform(entryPath),
            });
          }
        } catch {
          // Ignore individual folder errors
        }
      }
    } catch (error) {
      logger.error({ err: error, dir: dirPath }, 'Error scanning game folders');
    }
    
    return gameFolders;
  }

  private async analyzeGameFolder(folderPath: string): Promise<boolean> {
    try {
      let found = false;
      const walk = (dir: string, depth = 0): void => {
        if (depth > 3 || found) return; // Limit depth to avoid infinite loops
        
        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          
          if (entry.isFile()) {
            const ext = path.extname(entry.name).toLowerCase();
            if (['.exe', '.sh', '.appimage', '.bin'].includes(ext)) {
              found = true;
              return;
            }
            
            const lowerName = entry.name.toLowerCase();
            if (['config.ini', 'settings.ini', 'config.json', 'settings.json'].includes(lowerName)) {
              found = true;
              return;
            }
          }
          
          if (entry.isDirectory()) {
            const lowerName = entry.name.toLowerCase();
            if (['save', 'saves', 'savegames', 'savegame', 'profile', 'profiles'].includes(lowerName)) {
              // This is likely a save directory
              found = true;
              return;
            }
            
            if (depth < 2) {
              walk(fullPath, depth + 1);
              if (found) return;
            }
          }
        }
      };
      
      walk(folderPath);
      
      return found;
    } catch {
      return false;
    }
  }

  private detectPlatform(dirPath: string): GameFolder['platform'] {
    const lowerPath = dirPath.toLowerCase();
    
    if (lowerPath.includes('steam') || lowerPath.includes('steamapps')) return 'steam';
    if (lowerPath.includes('epic')) return 'epic';
    if (lowerPath.includes('gog') || lowerPath.includes('gog galaxy')) return 'gog';
    if (lowerPath.includes('origin')) return 'origin';
    if (lowerPath.includes('ubisoft') || lowerPath.includes('ubisoft game launcher')) return 'ubisoft';
    if (lowerPath.includes('battle.net')) return 'battle.net';
    if (lowerPath.includes('itch') || lowerPath.includes('itch.io')) return 'itch';
    if (lowerPath.includes('lutris')) return 'other';
    if (lowerPath.includes('heroic')) return 'epic';
    if (lowerPath.includes('bottles')) return 'other';
    
    return 'other';
  }

  private calculateDirectorySize(dirPath: string): number {
    let totalSize = 0;
    
    try {
      const walk = (dir: string) => {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          
          if (entry.isSymbolicLink()) continue;
          
          if (entry.isDirectory()) {
            walk(fullPath);
          } else {
            try {
              const stats = fs.statSync(fullPath);
              totalSize += stats.size;
            } catch {
              // Ignore files we can't stat
            }
          }
        }
      };
      
      walk(dirPath);
    } catch {
      // Ignore errors
    }
    
    return totalSize;
  }

  private generateId(dirPath: string): string {
    return crypto.createHash('sha1').update(dirPath).digest('hex').slice(0, 16);
  }

  // Public API
  async scanAll(): Promise<GameFolder[]> {
    for (const dir of this.watchDirs) {
      await this.scanDirectory(dir);
    }
    
    this.emit('scanComplete', Array.from(this.folders.values()));
    return Array.from(this.folders.values());
  }

  getFolders(): GameFolder[] {
    return Array.from(this.folders.values());
  }

  getFolder(dirPath: string): GameFolder | undefined {
    return this.folders.get(dirPath);
  }

  startAutoScan(): void {
    if (this.autoScanTimer) return;
    
    this.autoScanTimer = setInterval(() => {
      void this.scanAll();
    }, this.scanIntervalMs);
    if (typeof (this.autoScanTimer as unknown as { unref?: () => void }).unref === 'function') {
      (this.autoScanTimer as unknown as { unref: () => void }).unref();
    }
    
    // Initial scan
    void this.scanAll();
  }

  stopAutoScan(): void {
    if (this.autoScanTimer) {
      clearInterval(this.autoScanTimer);
      this.autoScanTimer = null;
    }
  }

  async refreshFolder(dirPath: string): Promise<GameFolder | null> {
    return this.scanDirectory(dirPath);
  }

  removeFolder(dirPath: string): boolean {
    const watched = this.watchers.get(dirPath);
    if (watched) {
      watched.watcher.close();
      this.watchers.delete(dirPath);
    }
    return this.folders.delete(dirPath);
  }

  /**
   * Re-read watch dirs (e.g. after a config hot-reload): close watchers
   * for removed dirs, add watchers for new dirs, rescan everything.
   */
  async refreshWatchers(): Promise<GameFolder[]> {
    const wanted = new Set(this.getWatchDirs());
    for (const [dir, watched] of this.watchers) {
      if (!wanted.has(dir)) {
        watched.watcher.close();
        this.watchers.delete(dir);
        this.folders.delete(dir);
      }
    }
    this.watchDirs = [...wanted];
    this.setupWatchers();
    return this.scanAll();
  }

  /** Subscribe to ConfigManager hot-reload so new watchDirs take effect. */
  subscribeToConfigChanges(): void {
    if (this.configChangeHandler) return;
    import('../utils/config.js').then(({ initConfig }) => {
      // initConfig() after stop() would resurrect listeners — bail out.
      if (!this.configChangeHandler) return;
      const mgr = initConfig();
      const handler = () => {
        const pending = setTimeout(() => {
          void this.refreshWatchers().catch((err) => {
            if (this.listenerCount('error') > 0) this.emit('error', err);
          });
          if (this.options.onChange) this.options.onChange(this.getFolders());
        }, 500);
        if (typeof (pending as unknown as { unref?: () => void }).unref === 'function') {
          (pending as unknown as { unref: () => void }).unref();
        }
      };
      this.configChangeHandler = handler;
      mgr.on('change', handler);
      this.configManagerForUnsub = mgr;
    }).catch((err) => {
      logger.error({ err }, 'FolderTracker could not subscribe to config changes');
      if (this.options.onError && err instanceof Error) this.options.onError(err);
    });
    // Mark as subscribing so a second call is a no-op and stop() can cancel.
    this.configChangeHandler = () => undefined;
  }

  stop(): void {
    this.stopAutoScan();

    if (this.configManagerForUnsub && this.configChangeHandler) {
      this.configManagerForUnsub.off('change', this.configChangeHandler);
      this.configManagerForUnsub = null;
    }
    this.configChangeHandler = null;
    
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();

    for (const [, watcher] of this.watchers) {
      watcher.watcher.close();
    }
    this.watchers.clear();
    
    this.folders.clear();
    this.removeAllListeners();
  }
}

// Singleton instance
let globalFolderTracker: FolderTracker | null = null;

export function initFolderTracker(options?: FolderTrackerOptions): FolderTracker {
  if (globalFolderTracker) return globalFolderTracker;
  
  globalFolderTracker = new FolderTracker(options);
  return globalFolderTracker;
}

export function getFolderTracker(): FolderTracker | null {
  return globalFolderTracker;
}

export function getTrackedFolders(): GameFolder[] {
  return globalFolderTracker?.getFolders() || [];
}