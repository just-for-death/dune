import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';

export interface DuneConfig {
  server: {
    port: number;
    host: string;
  };
  data: {
    savesDir: string;
    backupDir: string;
    hltbCacheDir: string;
    watchDirs?: string[];
  };
  steamGridDb: {
    apiKey: string;
  };
  ollama: {
    endpoint: string;
    model: string;
  };
  ollamaAI: {
    enabled: boolean;
    timeout: number;
  };
  sync: {
    maxVersions: number;
    autoSync: boolean;
    syncInterval: number;
  };
  client: {
    autoLaunch: boolean;
    minimizeToTray: boolean;
  };
}

const DEFAULT_CONFIG: DuneConfig = {
  server: {
    port: 3030,
    host: '0.0.0.0',
  },
  data: {
    savesDir: 'data/saves',
    backupDir: 'data/backups',
    hltbCacheDir: 'data/hltb-cache',
  },
  steamGridDb: {
    apiKey: '',
  },
  ollama: {
    endpoint: 'http://localhost:11434',
    model: 'phi4-mini:latest',
  },
  ollamaAI: {
    enabled: true,
    timeout: 60000,
  },
  sync: {
    maxVersions: 10,
    autoSync: true,
    syncInterval: 300000, // 5 minutes
  },
  client: {
    autoLaunch: false,
    minimizeToTray: true,
  },
};

function deepMerge<T extends object>(base: T, override: Partial<T>): T {
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(override ?? {})) {
    if (v !== null && typeof v === 'object' && !Array.isArray(v) &&
        (base as Record<string, unknown>)[k] !== null && typeof (base as Record<string, unknown>)[k] === 'object') {
      out[k] = deepMerge(
        (base as Record<string, unknown>)[k] as object,
        v as Partial<object>,
      );
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out as T;
}

interface ConfigWatcherOptions {
  configPath: string;
  onChange?: (config: DuneConfig) => void;
  onError?: (error: Error) => void;
}

/**
 * Config manager with hot-reload support (like fish shell)
 */
export class ConfigManager extends EventEmitter {
  private config: DuneConfig;
  private configPath: string;
  private watcher: fs.FSWatcher | null = null;
  private dirWatcher: fs.FSWatcher | null = null;
  private watcherDebounce: NodeJS.Timeout | null = null;
  private readonly options: ConfigWatcherOptions;

  constructor(options: ConfigWatcherOptions) {
    super();
    this.configPath = options.configPath;
    this.options = options;
    this.config = this.loadConfig();
    this.startWatcher();
  }

  private getConfigDir(): string {
    if (this.configPath) {
      const dir = path.dirname(this.configPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      return dir;
    }
    const configDir = process.env.DUNE_CONFIG_DIR || path.join(process.cwd(), 'config');
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }
    return configDir;
  }

  private getConfigFilePath(): string {
    if (this.configPath) return this.configPath;
    return path.join(this.getConfigDir(), 'dune.config.json');
  }

  private loadConfig(): DuneConfig {
    const configFile = this.getConfigFilePath();
    
    if (!fs.existsSync(configFile)) {
      this.saveConfig(DEFAULT_CONFIG);
      return { ...DEFAULT_CONFIG };
    }

    try {
      const content = fs.readFileSync(configFile, 'utf-8');
      const parsed = JSON.parse(content) as Partial<DuneConfig>;
      return deepMerge(DEFAULT_CONFIG, parsed);
    } catch (error) {
      console.error('Failed to load config, using defaults:', error);
      return { ...DEFAULT_CONFIG };
    }
  }

  private saveConfig(config: DuneConfig): void {
    const configFile = this.getConfigFilePath();
    const configDir = this.getConfigDir();
    
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }
    
    const tempFile = `${configFile}.tmp`;
    fs.writeFileSync(tempFile, JSON.stringify(config, null, 2));
    fs.renameSync(tempFile, configFile);
  }

  private startWatcher(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.dirWatcher) {
      this.dirWatcher.close();
      this.dirWatcher = null;
    }

    const configFile = this.getConfigFilePath();

    // Ensure config file exists
    if (!fs.existsSync(configFile)) {
      this.saveConfig(this.config);
    }

    try {
      this.watcher = fs.watch(configFile, { persistent: true }, (eventType) => {
        if (eventType === 'change') {
          if (this.watcherDebounce) {
            clearTimeout(this.watcherDebounce);
          }
          this.watcherDebounce = setTimeout(() => {
            this.reloadConfig();
          }, 100);
        }
      });
    } catch (error) {
      console.error('Failed to watch config file:', error);
    }

    // Also watch the config directory for new files
    try {
      this.dirWatcher = fs.watch(this.getConfigDir(), { persistent: true, recursive: false }, (eventType, filename) => {
        if (eventType === 'rename' && filename === 'dune.config.json') {
          this.reloadConfig();
        }
      });
    } catch (error) {
      console.error('Failed to watch config dir:', error);
    }
  }

  private reloadConfig(): void {
    try {
      const newConfig = this.loadConfig();
      const oldConfig = this.config;
      this.config = newConfig;
      
      // Emit change events for specific sections that changed
      this.emit('change', newConfig, oldConfig);
      
      if (this.options.onChange) {
        this.options.onChange(newConfig);
      }
    } catch (error) {
      console.error('Failed to reload config:', error);
      if (this.options.onError) {
        this.options.onError(error as Error);
      }
    }
  }

  getConfig(): DuneConfig {
    return { ...this.config };
  }

  updateConfig(updates: Partial<DuneConfig>): void {
    this.config = deepMerge(this.config, updates);
    this.saveConfig(this.config);
    this.emit('change', this.config);
  }

  getConfigPath(): string {
    return this.getConfigFilePath();
  }

  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.dirWatcher) {
      this.dirWatcher.close();
      this.dirWatcher = null;
    }
    if (this.watcherDebounce) {
      clearTimeout(this.watcherDebounce);
      this.watcherDebounce = null;
    }
  }
}

// Global config instance
let globalConfigManager: ConfigManager | null = null;

export function initConfig(customPath?: string): ConfigManager {
  if (globalConfigManager) {
    return globalConfigManager;
  }
  
  const resolvedPath = customPath || process.env.DUNE_CONFIG_PATH || path.join(process.cwd(), 'config', 'dune.config.json');
  
  globalConfigManager = new ConfigManager({
    configPath: resolvedPath,
    onChange: () => {
      console.log('[Config] Configuration reloaded');
    },
    onError: (error) => {
      console.error('Config error:', error);
    },
  });
  
  return globalConfigManager;
}

export function getConfig(): DuneConfig {
  if (!globalConfigManager) {
    return initConfig().getConfig();
  }
  return globalConfigManager.getConfig();
}

// Type-safe config accessors
export const config = {
  get server() { return getConfig().server; },
  get data() { return getConfig().data; },
  get steamGridDb() { return getConfig().steamGridDb; },
  get ollama() { return getConfig().ollama; },
  get ollamaAI() { return getConfig().ollamaAI; },
  get sync() { return getConfig().sync; },
  get client() { return getConfig().client; },
};