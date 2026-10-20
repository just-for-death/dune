export interface LaunchOptions {
  appId?: string;
  heroicId?: string;
  lutrisSlug?: string;
  winePrefix?: string;
  protonPath?: string;
  useUmu?: boolean;
  env?: Record<string, string>;
  cwd?: string;
}

export interface LaunchCommand {
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface LaunchStrategy {
  canLaunch(game: { source?: string; sourceId?: string; linPath?: string; winPath?: string }, options?: LaunchOptions): boolean;
  getCommand(game: { source?: string; sourceId?: string; linPath?: string; winPath?: string }, options?: LaunchOptions): LaunchCommand | null;
}
