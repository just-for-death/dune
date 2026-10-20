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

export type LaunchableGame = {
  source?: string;
  sourceId?: string;
  linPath?: string;
  winPath?: string;
  steamAppId?: string;
  heroicId?: string;
  lutrisSlug?: string;
  winePrefix?: string;
  protonPath?: string;
  executable?: string;
  emulator?: string;
  romPath?: string;
};

export interface LaunchStrategy {
  canLaunch(game: LaunchableGame, options?: LaunchOptions): boolean;
  getCommand(game: LaunchableGame, options?: LaunchOptions): LaunchCommand | null;
}
