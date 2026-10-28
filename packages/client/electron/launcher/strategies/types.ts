import type { CoreLookupDeps } from '../retroarchCores.js';

export interface LaunchOptions {
  appId?: string;
  heroicId?: string;
  lutrisSlug?: string;
  winePrefix?: string;
  protonPath?: string;
  useUmu?: boolean;
  env?: Record<string, string>;
  cwd?: string;
  /** DUN-075: where to look for RetroArch cores (defaults to the platform's core folders). */
  coreLookup?: CoreLookupDeps;
}

export interface LaunchCommand {
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
}

/** DUN-074: a launch handed to the OS URL handler (shell.openExternal), e.g. steam://rungameid/<id>. */
export interface LaunchUrl {
  url: string;
}

/** What a strategy produces: a process to spawn or a URL to open. */
export type LaunchPlan = LaunchCommand | LaunchUrl;

export function isUrlLaunch(plan: LaunchPlan): plan is LaunchUrl {
  return typeof (plan as LaunchUrl).url === 'string';
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
  /** Install folder; only used as a launch target when it is a file. */
  installPath?: string;
  emulator?: string;
  romPath?: string;
};

export interface LaunchStrategy {
  canLaunch(game: LaunchableGame, options?: LaunchOptions): boolean;
  getCommand(game: LaunchableGame, options?: LaunchOptions): LaunchPlan | null;
  /** Why this strategy refuses a game it would otherwise handle (shown to the user), or null. */
  refusal?(game: LaunchableGame, options?: LaunchOptions): string | null;
}
