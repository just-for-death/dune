import React, { useState, useEffect, useCallback } from 'react';
import { render, Text, Box, useInput, useApp } from 'ink';
import { database } from '../db/index.js';
import { steamGridKeyStatus } from '../services/providerKeys.js';

type ViewName = 'dashboard' | 'games' | 'sync' | 'settings' | 'logs';

interface LogEntry {
  time: string;
  level: string;
  message: string;
}

interface AppState {
  currentView: ViewName;
  selectedGame: string | null;
  games: Array<{ id: number | string; name: string; status?: string; platform?: string; lastSync?: string }>;
  syncStatus: 'idle' | 'syncing' | 'success' | 'error';
  logs: LogEntry[];
  showHelp: boolean;
}

const VIEWS: ViewName[] = ['dashboard', 'games', 'sync', 'settings', 'logs'];

/**
 * DUN-107: the TUI shows only values the server really uses: the port the
 * same way server.ts reads it (PORT env, default 3030) and maxVersions from
 * the DB settings. The old ConfigManager (config/dune.config.json in cwd,
 * autoSync/syncInterval/host) was never read by the server and is gone.
 */
interface TuiConfig {
  port: number;
  maxVersions: number | null;
}

function readTuiConfig(): TuiConfig {
  const port = parseInt(process.env.PORT || '3030', 10);
  let maxVersions: number | null = null;
  try { maxVersions = database.getSettings().maxVersions; } catch { /* DB unavailable */ }
  return { port, maxVersions };
}

function Header({ currentView }: { currentView: ViewName }) {
  const items: Array<{ key: string; label: string; view: ViewName }> = [
    { key: '1', label: 'Dashboard', view: 'dashboard' },
    { key: '2', label: 'Games', view: 'games' },
    { key: '3', label: 'Sync', view: 'sync' },
    { key: '4', label: 'Settings', view: 'settings' },
    { key: '5', label: 'Logs', view: 'logs' },
  ];
  return (
    <Box flexDirection="column" borderStyle="single" borderColor="cyan" paddingX={1}>
      <Box flexDirection="row">
        <Text color="cyan" bold>DUNE</Text>
        <Text color="gray"> | Game Save Sync Manager</Text>
      </Box>
      <Box flexDirection="row" flexWrap="wrap">
        {items.map((item) => (
          <Box key={item.view} marginRight={2}>
            <Text color={currentView === item.view ? 'black' : 'gray'} backgroundColor={currentView === item.view ? 'cyan' : undefined}>
              [{item.key}]{item.label}
            </Text>
          </Box>
        ))}
        <Box marginRight={2}>
          <Text color="gray">[H]Help [Q]Quit</Text>
        </Box>
      </Box>
    </Box>
  );
}

function DashboardView({ state }: { state: AppState }) {
  return (
    <Box flexDirection="column" padding={1}>
      <Text bold>Dashboard</Text>
      <Text color="gray">Overview of your local and synchronized game saves.</Text>
      <Box flexDirection="row" marginTop={1}>
        <Box borderStyle="round" borderColor="cyan" paddingX={2} paddingY={1} marginRight={1}>
          <Text bold>{state.games.length}</Text>
          <Text color="gray"> Tracked Games</Text>
        </Box>
        <Box borderStyle="round" borderColor="yellow" paddingX={2} paddingY={1}>
          <Text bold>{state.syncStatus.toUpperCase()}</Text>
          <Text color="gray"> Sync</Text>
        </Box>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text bold>Tracked Games</Text>
        {state.games.length === 0 ? (
          <Text color="gray">No games tracked yet.</Text>
        ) : (
          state.games.slice(0, 10).map((game) => (
            <Box key={String(game.id)} flexDirection="row">
              <Text color="cyan">{String(game.name).slice(0, 30)}</Text>
              <Text color="gray"> - {game.status ?? 'Pending'}</Text>
            </Box>
          ))
        )}
      </Box>
    </Box>
  );
}

function GamesView({ state }: { state: AppState }) {
  return (
    <Box flexDirection="column" padding={1}>
      <Box flexDirection="row" justifyContent="space-between">
        <Text bold>Games Manager</Text>
        <Text color="gray">[S]ync [R]efresh</Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {state.games.length === 0 ? (
          <Text color="gray">No games tracked yet.</Text>
        ) : (
          state.games.map((game, index) => (
            <Box key={String(game.id)} flexDirection="row">
              <Box width={4}>
                <Text color={state.selectedGame === String(game.id) ? 'black' : 'white'} backgroundColor={state.selectedGame === String(game.id) ? 'cyan' : undefined}>
                  {index + 1}
                </Text>
              </Box>
              <Box width={30}>
                <Text color={state.selectedGame === String(game.id) ? 'black' : 'white'} backgroundColor={state.selectedGame === String(game.id) ? 'cyan' : undefined}>
                  {String(game.name).slice(0, 28)}
                </Text>
              </Box>
              <Box width={16}>
                <Text color="gray">{(game.platform ?? 'Unknown').slice(0, 14)}</Text>
              </Box>
              <Text color="gray">{game.lastSync ?? 'Never'}</Text>
            </Box>
          ))
        )}
      </Box>
    </Box>
  );
}

function SyncView({ state, cfg }: { state: AppState; cfg: TuiConfig }) {
  const color = state.syncStatus === 'success' ? 'green' : state.syncStatus === 'error' ? 'red' : 'yellow';
  return (
    <Box flexDirection="column" padding={1}>
      <Box flexDirection="row" justifyContent="space-between">
        <Text bold>Sync Manager</Text>
      </Box>
      <Box borderStyle="round" borderColor={color} padding={1} marginTop={1}>
        <Text>Status: </Text>
        <Text color={color}>{state.syncStatus.toUpperCase()}</Text>
      </Box>
      <Box flexDirection="row" marginTop={1}>
        <Text>Max Versions: </Text>
        <Text color="cyan">{cfg.maxVersions ?? 'unavailable'}</Text>
      </Box>
      <Box flexDirection="row" marginTop={1}>
        <Text>[S] Start Sync</Text>
      </Box>
    </Box>
  );
}

function SettingsView({ cfg }: { cfg: TuiConfig }) {
  // DUN-092: the key lives encrypted in the DB; the TUI only shows status.
  let sgdbSet = false;
  try { sgdbSet = steamGridKeyStatus().set; } catch { /* DB unavailable */ }
  return (
    <Box flexDirection="column" padding={1}>
      <Text bold>Settings</Text>
      <Box borderStyle="round" borderColor="cyan" padding={1} marginTop={1} flexDirection="column">
        <Text bold>Server</Text>
        <Box flexDirection="row">
          <Text>Port: </Text>
          <Text color="cyan">{cfg.port}</Text>
        </Box>
      </Box>
      <Box borderStyle="round" borderColor="cyan" padding={1} marginTop={1} flexDirection="column">
        <Text bold>Sync</Text>
        <Box flexDirection="row">
          <Text>Max Versions: </Text>
          <Text color="cyan">{cfg.maxVersions ?? 'unavailable'}</Text>
        </Box>
      </Box>
      <Box borderStyle="round" borderColor="cyan" padding={1} marginTop={1} flexDirection="column">
        <Text bold>SteamGridDB</Text>
        <Box flexDirection="row">
          <Text>API Key: </Text>
          <Text color={sgdbSet ? 'green' : 'red'}>{sgdbSet ? 'Set' : 'Not Set'}</Text>
        </Box>
      </Box>
    </Box>
  );
}

function LogsView({ state }: { state: AppState }) {
  return (
    <Box flexDirection="column" padding={1}>
      <Box flexDirection="row">
        <Text bold>Logs</Text>
        <Text color="gray"> [C] Clear logs</Text>
      </Box>
      <Box borderStyle="round" borderColor="cyan" padding={1} marginTop={1} flexDirection="column">
        {state.logs.slice(0, 20).map((log, index) => (
          <Box key={index} flexDirection="row">
            <Box width={10}>
              <Text color="gray">{log.time}</Text>
            </Box>
            <Box width={8}>
              <Text color={log.level === 'error' ? 'red' : log.level === 'warn' ? 'yellow' : log.level === 'success' ? 'green' : 'cyan'}>
                {log.level.toUpperCase()}
              </Text>
            </Box>
            <Text>{log.message}</Text>
          </Box>
        ))}
      </Box>
    </Box>
  );
}

function HelpView() {
  const rows: Array<[string, string]> = [
    ['Tab', 'Switch views'],
    ['1-5', 'Switch views'],
    ['H', 'Toggle help'],
    ['Q / Ctrl+C', 'Quit'],
    ['S', 'Start sync'],
    ['C', 'Clear logs'],
    ['R', 'Refresh data'],
  ];
  return (
    <Box borderStyle="round" borderColor="cyan" padding={2} margin={1} flexDirection="column">
      <Text bold>Keyboard Shortcuts</Text>
      <Box marginTop={1} flexDirection="column">
        {rows.map(([key, desc]) => (
          <Box key={key} flexDirection="row">
            <Box width={12}>
              <Text color="cyan">{key}</Text>
            </Box>
            <Text>{desc}</Text>
          </Box>
        ))}
      </Box>
    </Box>
  );
}

export default function App() {
  const { exit } = useApp();
  const [cfg] = useState<TuiConfig>(readTuiConfig);
  const [state, setState] = useState<AppState>({
    currentView: 'dashboard',
    selectedGame: null,
    games: [],
    syncStatus: 'idle',
    logs: [],
    showHelp: false,
  });

  const addLog = useCallback((level: string, message: string) => {
    setState((prev) => ({
      ...prev,
      logs: [{ time: new Date().toLocaleTimeString(), level, message }, ...prev.logs].slice(0, 100),
    }));
  }, []);

  const refreshGames = useCallback(() => {
    try {
      const games = database.getGames() ?? [];
      setState((prev) => ({ ...prev, games }));
    } catch (error) {
      addLog('error', `Failed to load games: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [addLog]);

  useEffect(() => {
    refreshGames();
    setState((prev) => ({
      ...prev,
      logs: [
        { time: new Date().toLocaleTimeString(), level: 'info', message: 'Dune TUI started' },
      ],
    }));
  }, [refreshGames]);

  const handleSync = useCallback(async () => {
    setState((prev) => ({ ...prev, syncStatus: 'syncing' }));
    try {
      // Local server route is POST /api/local-sync (authenticated).
      // The TUI talks to the local daemon; the key comes from DUNE_API_KEY.
      const apiKey = process.env.DUNE_API_KEY ?? '';
      const result = await fetch(`http://localhost:${cfg.port}/api/local-sync`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { 'x-api-key': apiKey } : {}),
        },
      });
      if (result.ok) {
        setState((prev) => ({ ...prev, syncStatus: 'success' }));
        addLog('success', 'Sync completed successfully');
      } else if (result.status === 401 || result.status === 403) {
        throw new Error('Sync rejected: set DUNE_API_KEY to a valid server key');
      } else {
        throw new Error(`Sync failed: ${result.status}`);
      }
    } catch (error) {
      setState((prev) => ({ ...prev, syncStatus: 'error' }));
      addLog('error', `Sync failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
    refreshGames();
  }, [addLog, cfg.port, refreshGames]);

  useInput((input, key) => {
    if ((key.ctrl && input === 'c') || input === 'q' || input === 'Q') {
      exit();
      return;
    }
    if (key.tab) {
      setState((prev) => {
        const idx = VIEWS.indexOf(prev.currentView);
        return { ...prev, currentView: VIEWS[(idx + 1) % VIEWS.length], showHelp: false };
      });
      return;
    }
    const lower = input.toLowerCase();
    if (lower === 'h') {
      setState((prev) => ({ ...prev, showHelp: !prev.showHelp }));
      return;
    }
    if (lower === 'c') {
      setState((prev) => ({ ...prev, logs: [] }));
      return;
    }
    if (lower === 'r') {
      refreshGames();
      return;
    }
    if (lower === 's') {
      void handleSync();
      return;
    }
    const viewByKey: Record<string, ViewName> = {
      '1': 'dashboard',
      '2': 'games',
      '3': 'sync',
      '4': 'settings',
      '5': 'logs',
    };
    const next = viewByKey[input];
    if (next) {
      setState((prev) => ({ ...prev, currentView: next, showHelp: false }));
    }
  });

  const renderCurrentView = () => {
    switch (state.currentView) {
      case 'dashboard':
        return <DashboardView state={state} />;
      case 'games':
        return <GamesView state={state} />;
      case 'sync':
        return <SyncView state={state} cfg={cfg} />;
      case 'settings':
        return <SettingsView cfg={cfg} />;
      case 'logs':
        return <LogsView state={state} />;
      default:
        return <DashboardView state={state} />;
    }
  };

  return (
    <Box flexDirection="column">
      <Header currentView={state.currentView} />
      {state.showHelp ? <HelpView /> : renderCurrentView()}
      <Box paddingX={1}>
        <Text color="gray">Tab: switch | 1-5: views | S: sync | R: refresh | H: help | Q: quit</Text>
      </Box>
    </Box>
  );
}

export function startTUI(): void {
  render(<App />);
}

const entry = process.argv[1] ?? '';
if (entry.endsWith('tui/index.tsx') || entry.endsWith('tui/index.js')) {
  startTUI();
}
